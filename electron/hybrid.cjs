/**
 * Long exports in pieces. Stretches of the timeline that are just one video playing, untouched, go
 * straight through FFmpeg, far faster than compositing them frame by frame. Everything else (transitions,
 * text, effects) comes from the compositor. Each piece is a raw video stream with the same encoder
 * settings and no B-frames, so joining them is plain concatenation with exact frame counts, and
 * the audio stays in sync however many cuts there are.
 */
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { FFMPEG } = require("./media.cjs");
const { ExportSession, directPieceArgs, muxArgs, overlayPieceArgs, renderPieceArgs } = require("./exporter.cjs");
const { describeVideo } = require("./frameReader.cjs");

class HybridExport {
  /** `pieces`, in timeline order: { kind: "direct" | "render", frames, ... }. Direct ones start right away. */
  constructor(job, gpu, pieces) {
    this.job = job;
    this.gpu = gpu;
    this.pieces = pieces;
    this.dir = fs.mkdtempSync(path.join(path.dirname(job.outPath), ".cena-export-"));
    this.progress = pieces.map(() => 0);
    this.children = new Set();
    this.failed = [];
    this.cancelled = false;
    this.encoder = null;
    this.directDone = this.runDirect();
  }

  fileOf(index) {
    return path.join(this.dir, `${String(index).padStart(6, "0")}.es`);
  }

  async runDirect() {
    // Pieces with texts on top wait for the compositor's drawing; the others need nothing from it.
    const waiting = this.pieces.flatMap((p, index) => (p.kind === "direct" && !p.overlay ? [index] : []));
    // One x264 already fills the processor; the graphics card keeps up with a few decoders.
    const workers = Array.from({ length: this.gpu ? 3 : 1 }, async () => {
      while (waiting.length && !this.cancelled) {
        const index = waiting.shift();
        if (!(await this.encodeDirect(index)) && !this.cancelled) this.failed.push(index);
      }
    });
    await Promise.all(workers);
    this.failed.sort((a, b) => a - b);
    return this.failed;
  }

  /** True when the piece came out with exactly the frames it should have. */
  async encodeDirect(index) {
    const piece = this.pieces[index];
    const info = await describeVideo(piece.path).catch(() => null);
    if (!info) return false;
    const pipInfo = piece.pip ? await describeVideo(piece.pip.path).catch(() => null) : null;
    if (piece.pip && !pipInfo) return false;
    const child = spawn(FFMPEG, directPieceArgs(this.job, this.gpu, piece, info, this.fileOf(index), pipInfo), { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    this.children.add(child);
    let tail = "";
    let frames = 0;
    child.stdout.on("data", (chunk) => {
      tail += chunk.toString("latin1");
      const lines = tail.split(/\r?\n/);
      tail = lines.pop();
      for (const line of lines) {
        const m = /^frame=(\d+)/.exec(line);
        if (m) {
          frames = Number(m[1]);
          this.progress[index] = Math.min(frames, piece.frames);
        }
      }
    });
    const code = await new Promise((resolve) => {
      child.on("error", () => resolve(-1));
      child.on("close", resolve);
    });
    this.children.delete(child);
    if (code === 0 && frames === piece.frames) return true;
    this.progress[index] = 0;
    return false;
  }

  framesDone() {
    return this.progress.reduce((a, b) => a + b, 0);
  }

  /** Start encoding a piece from the compositor (also used for direct pieces that failed). */
  beginRender(index) {
    this.encoder = new ExportSession({ outPath: this.fileOf(index) }, null, renderPieceArgs(this.job, this.gpu, this.fileOf(index)));
    this.renderIndex = index;
  }

  /** Start a direct piece that takes its texts from the compositor. False when the footage cannot be read this way. */
  async beginOverlay(index, box) {
    const piece = this.pieces[index];
    const info = await describeVideo(piece.path).catch(() => null);
    const pipInfo = piece.pip ? await describeVideo(piece.pip.path).catch(() => null) : null;
    if (!info || (piece.pip && !pipInfo) || this.cancelled) return false;
    this.encoder = new ExportSession({ outPath: this.fileOf(index) }, null, overlayPieceArgs(this.job, this.gpu, piece, info, box, this.fileOf(index), pipInfo));
    this.renderIndex = index;
    return true;
  }

  /** A piece that failed half way: its encoder goes, its count starts again. */
  dropRender(index) {
    this.encoder?.cancel();
    this.encoder = null;
    this.progress[index] = 0;
  }

  writeFrame(bytes) {
    this.progress[this.renderIndex]++;
    return this.encoder.writeFrame(bytes);
  }

  async endRender() {
    const encoder = this.encoder;
    this.encoder = null;
    await encoder.finish();
  }

  /** Join the pieces and add the sound. */
  async finish() {
    await this.directDone;
    const { args, cleanup } = muxArgs(this.job);
    const child = spawn(FFMPEG, args, { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    this.children.add(child);
    let stderr = "";
    child.stderr.on("data", (c) => (stderr = (stderr + c).slice(-4000)));
    const closed = new Promise((resolve) => {
      child.on("error", () => resolve(-1));
      child.on("close", resolve);
    });
    child.stdin.on("error", () => {}); // reported through the exit code
    for (let index = 0; index < this.pieces.length && !this.cancelled; index++) {
      const file = this.fileOf(index);
      for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) {
        if (!child.stdin.write(chunk)) await new Promise((resolve) => child.stdin.once("drain", resolve));
      }
      await fsp.rm(file, { force: true });
    }
    child.stdin.end();
    const code = await closed;
    cleanup();
    this.children.delete(child);
    await this.removeDir();
    if (this.cancelled) throw new DOMException("Exportação cancelada", "AbortError");
    if (code !== 0) throw new Error(`ffmpeg saiu com código ${code}: ${stderr.trim()}`);
    return this.job.outPath;
  }

  removeDir() {
    return fsp.rm(this.dir, { recursive: true, force: true }).catch(() => {});
  }

  cancel() {
    this.cancelled = true;
    this.encoder?.cancel();
    this.encoder = null;
    for (const child of this.children) child.kill();
    // After everything has let go of its files.
    void this.directDone.finally(() => setTimeout(() => void this.removeDir(), 300));
  }
}

module.exports = { HybridExport };

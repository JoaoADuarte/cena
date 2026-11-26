/**
 * Decodes a video straight through with FFmpeg for export. Seeking a <video> element for every frame
 * makes the browser decode from the previous keyframe each time; reading in order decodes each
 * frame once. Frames carry their real timestamps, so variable frame rate footage stays exact.
 *
 * HDR footage (games recorded in HDR: PQ or HLG, BT.2020) is tone-mapped to ordinary BT.709 here, and
 * non-square pixels are scaled square: the browser seeks such long files far too slowly, frame by frame.
 * Only transparency is refused, and the export seeks it as before.
 */
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { FFMPEG, FFPROBE, run } = require("./media.cjs");

/** Decoded frames held ahead of the one in use. Each is width × height × 4 bytes. */
const MAX_QUEUE = 3;
const READ_TIMEOUT_MS = 20000;
const PTS_EPSILON = 1e-4;
/** Started this much early, so the frame on screen at the requested time is decoded too. */
const LEAD_SECONDS = 1;

const PLANAR = /^(yuvj?4(20|22|44)p(1[02]le)?|nv12|nv21|p010le)$/;
/** FFmpeg's transfer names as zscale writes them. */
const ZSCALE_TRANSFER = { smpte2084: "smpte2084", "arib-std-b67": "arib-std-b67", "bt2020-10": "2020_10", "bt2020-12": "2020_12" };
const TONE_MAPPED = new Set(["smpte2084", "arib-std-b67"]);

function sarIsSquare(sar) {
  if (!sar || sar === "0:1" || sar === "N/A") return true;
  const [a, b] = sar.split(":").map(Number);
  return a === b;
}

/** The YUV matrix the browser would use for this stream, or null when it is not one we convert. */
function colorMatrix(stream) {
  const space = stream.color_space;
  if (space === "bt709") return "bt709";
  if (space === "smpte170m" || space === "bt470bg") return "bt601";
  if (!space || space === "unknown") return stream.height < 720 ? "bt601" : "bt709";
  return null;
}

/** How to convert a file's video, or null if it must go through the browser. */
async function describe(file) {
  const out = await run(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_streams", "-print_format", "json", file]);
  const stream = JSON.parse(out.toString("utf8")).streams?.[0];
  if (!stream || !PLANAR.test(stream.pix_fmt ?? "")) return null;
  // VP9 keeps transparency apart from the picture, and FFmpeg's own decoder does not read it.
  const tags = Object.fromEntries(Object.entries(stream.tags ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  if (tags.alpha_mode && tags.alpha_mode !== "0") return null;
  const prefilter = [];
  let matrix = colorMatrix(stream);
  let fullRange = stream.color_range === "pc" || stream.pix_fmt.startsWith("yuvj");
  let pixFmt = stream.pix_fmt;
  const wide = ZSCALE_TRANSFER[stream.color_transfer] || stream.color_space === "bt2020nc" || stream.color_space === "bt2020c";
  if (wide) {
    // BT.2020 (and HDR) to BT.709 in limited range: what every later step already reads.
    const tin = ZSCALE_TRANSFER[stream.color_transfer] ?? "2020_10";
    const input = `zscale=tin=${tin}:min=${stream.color_space === "bt2020c" ? "bt2020c" : "bt2020nc"}:pin=bt2020:rin=${fullRange ? "full" : "limited"}`;
    if (TONE_MAPPED.has(stream.color_transfer)) prefilter.push(`${input}:t=linear:npl=100`, "format=gbrpf32le", "zscale=p=bt709", "tonemap=hable:desat=0", "zscale=t=bt709:m=bt709:r=limited", "format=yuv420p");
    else prefilter.push(`${input}:t=709:m=709:p=709:r=limited`, "format=yuv420p");
    matrix = "bt709";
    fullRange = false;
    pixFmt = "yuv420p";
  }
  if (!matrix) return null;
  let width = stream.width;
  if (!sarIsSquare(stream.sample_aspect_ratio)) {
    const [a, b] = stream.sample_aspect_ratio.split(":").map(Number);
    width = Math.max(2, Math.round((stream.width * a) / b / 2) * 2);
    prefilter.push(`scale=${width}:${stream.height}:flags=bicubic+accurate_rnd`, "setsar=1");
  }
  return { matrix, fullRange, pixFmt, width, height: stream.height, prefilter: prefilter.length ? prefilter.join(",") : null };
}

class FrameReader {
  constructor(file, start, { matrix, prefilter, width, height }) {
    this.from = Math.max(0, start - LEAD_SECONDS);
    this.pts = [];
    this.queue = [];
    this.chunks = [];
    this.bytes = 0;
    this.nextIndex = 0;
    this.size = null;
    this.ended = false;
    this.failed = false;
    this.last = null;
    this.wake = null;
    // The size that comes out (showinfo reads the frames before any scaling).
    if (prefilter) this.size = { width, height, bytes: width * height * 4 };
    const filters = `showinfo=checksum=0,${prefilter ? `${prefilter},` : ""}scale=in_color_matrix=${matrix}:out_range=full:flags=bicubic+accurate_rnd+full_chroma_int,format=rgba`;
    this.child = spawn(
      FFMPEG,
      [
        "-hide_banner", "-nostdin", "-loglevel", "info",
        ...(this.from > 0 ? ["-ss", this.from.toFixed(6)] : []),
        "-copyts", "-i", file,
        "-map", "0:v:0", "-an", "-sn", "-dn",
        "-fps_mode", "passthrough",
        "-vf", filters,
        "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let line = "";
    this.child.stderr.on("data", (chunk) => {
      line += chunk.toString("latin1");
      const lines = line.split(/\r?\n/);
      line = lines.pop();
      for (const text of lines) this.onLog(text);
      this.notify();
    });
    this.child.stdout.on("data", (chunk) => {
      this.chunks.push(chunk);
      this.bytes += chunk.length;
      this.takeFrames();
      this.notify();
    });
    this.child.on("error", () => this.finish(true));
    // "close": both pipes have been read to the end.
    this.child.on("close", (code) => this.finish(code !== 0 && !this.killed));
  }

  onLog(text) {
    // The filter's time base comes first. A frame's time is worked out from its whole-number timestamp:
    // "pts_time" is printed with six digits, which past 100 s is not enough to tell one frame from the next.
    const base = /showinfo.*config in time_base:\s*(\d+)\/(\d+)/.exec(text);
    if (base && Number(base[2]) > 0) this.timeBase = Number(base[1]) / Number(base[2]);
    const m = /showinfo.*\bn:\s*(\d+).*\bpts:\s*(-?\d+).*\bpts_time:(-?[\d.e+-]+).*\bs:(\d+)x(\d+)/.exec(text);
    if (!m) return;
    this.pts[Number(m[1])] = this.timeBase ? Number(m[2]) * this.timeBase : Number(m[3]);
    m.splice(2, 1);
    if (!this.size) {
      this.size = { width: Number(m[3]), height: Number(m[4]), bytes: Number(m[3]) * Number(m[4]) * 4 };
      this.takeFrames();
    }
  }

  takeFrames() {
    if (!this.size) return;
    const total = this.size.bytes;
    while (this.bytes >= total) {
      const data = Buffer.allocUnsafeSlow(total);
      let filled = 0;
      while (filled < total) {
        const chunk = this.chunks[0];
        const count = Math.min(chunk.length, total - filled);
        chunk.copy(data, filled, 0, count);
        filled += count;
        if (count === chunk.length) this.chunks.shift();
        else this.chunks[0] = chunk.subarray(count);
      }
      this.bytes -= total;
      this.queue.push({ index: this.nextIndex++, data });
    }
    if (this.queue.length >= MAX_QUEUE) this.child.stdout.pause();
  }

  finish(failed) {
    this.ended = true;
    if (failed) this.failed = true;
    this.notify();
  }

  notify() {
    this.wake?.();
    this.wake = null;
  }

  wait(deadline) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  dropFirst() {
    this.last = this.queue.shift();
    if (this.queue.length < MAX_QUEUE) this.child.stdout.resume();
  }

  /** The frame on screen at `seconds`. Times must not go backwards. Null: fall back to the browser. */
  async read(seconds) {
    const deadline = Date.now() + READ_TIMEOUT_MS;
    for (;;) {
      if (this.failed || Date.now() > deadline) return null;
      const [a, b] = this.queue;
      if (a && b) {
        const next = this.pts[b.index];
        if (next === undefined) {
          if (this.ended) return null;
        } else if (next <= seconds + PTS_EPSILON) {
          this.dropFirst();
          continue;
        } else if (this.pts[a.index] > seconds + PTS_EPSILON && (this.from > 0 || a.index > 0)) {
          return null; // Asked for a time before what was decoded.
        } else {
          return this.deliver(a);
        }
      } else if (this.ended) {
        // Past the last frame: it stays on screen.
        return a ? this.deliver(a) : this.last ? this.deliver(this.last) : null;
      }
      await this.wait(deadline);
    }
  }

  deliver(frame) {
    return { width: this.size.width, height: this.size.height, data: frame.data };
  }

  close() {
    this.killed = true;
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    this.child.kill();
    this.notify();
  }
}

function createFrameReaders() {
  const readers = new Map();
  const described = new Map();

  return {
    /** Start reading at `seconds`; null when this file has to go through the browser. */
    async open(file, seconds) {
      if (!described.has(file)) described.set(file, await describe(file).catch(() => null));
      const info = described.get(file);
      if (!info) return null;
      const id = crypto.randomUUID();
      readers.set(id, new FrameReader(file, seconds, info));
      return id;
    },
    frame: (id, seconds) => readers.get(id)?.read(seconds) ?? null,
    close(id) {
      readers.get(id)?.close();
      readers.delete(id);
    },
    closeAll() {
      for (const reader of readers.values()) reader.close();
      readers.clear();
      described.clear();
    },
  };
}

module.exports = { createFrameReaders, describeVideo: describe };

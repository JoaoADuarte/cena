/**
 * A project whose main track does not simply follow one recording (a highlight copied to the start, stretches
 * moved around, several recordings joined, a stretch sped up) becomes a new recording in the editor's order.
 * The agents then work on that file as on any other. Every sound track of the recordings stays a track of its own,
 * so the voice, the chat and the game can still be told apart and treated one by one.
 *
 * Each stretch is encoded on its own (exact to the frame, whatever the key frames of the source) and the pieces are
 * joined without encoding again.
 */
const fs = require("node:fs");
const path = require("node:path");
const { ff } = require("./ffmpeg.cjs");
const { FFPROBE, run } = require("../media.cjs");
const { gpuEncoders } = require("../exporter.cjs");

async function audioTracks(file) {
  const out = await run(FFPROBE, ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file]);
  return out.toString("utf8").trim().split(/\s+/).filter(Boolean).length;
}

/** FFmpeg's atempo takes 0.5 to 2 at a time. */
function tempo(speed) {
  const steps = [];
  let left = speed;
  while (left > 2) {
    steps.push(2);
    left /= 2;
  }
  while (left < 0.5) {
    steps.push(0.5);
    left /= 0.5;
  }
  steps.push(left);
  return steps.map((s) => `atempo=${s.toFixed(6)}`).join(",");
}

/** The best encoder this computer has, at the "recommended" quality of the export: the file is a working copy, encoded once more at the end. */
async function videoCodec() {
  const vendor = (await gpuEncoders().catch(() => ({}))).h264;
  if (vendor) return ["-c:v", `h264_${vendor.suffix}`, ...vendor.args(vendor.levels.h264[1]), "-pix_fmt", vendor.pixFmt];
  return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"];
}

/**
 * `segments`: [{ path, from (s in the source), length (s on the timeline), speed }] in timeline order.
 * Writes `out` (Matroska) and returns { duration, tracks, bytes }.
 */
async function flatten(segments, out, { width, height, fps, signal, progress = () => {} }) {
  if (!segments.length) throw new Error("A faixa principal está vazia.");
  const sources = [...new Set(segments.map((s) => s.path))];
  const counts = new Map(await Promise.all(sources.map(async (p) => [p, await audioTracks(p)])));
  const tracks = Math.max(1, ...counts.values());
  const W = Math.round(width / 2) * 2;
  const H = Math.round(height / 2) * 2;
  const codec = await videoCodec();
  const dir = path.join(path.dirname(out), "ordem-pedacos");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const total = segments.reduce((sum, s) => sum + s.length, 0);
  let done = 0;
  const names = [];
  try {
    for (const [i, s] of segments.entries()) {
      const speed = s.speed > 0 ? s.speed : 1;
      const have = counts.get(s.path);
      const name = `pedaco-${String(i + 1).padStart(4, "0")}.mkv`;
      // Silence stands in for a sound track that this recording does not have, so every piece has the same tracks.
      const silence = have < tracks ? ["-f", "lavfi", "-t", s.length.toFixed(6), "-i", "anullsrc=r=48000:cl=stereo"] : [];
      const maps = Array.from({ length: tracks }, (_, k) => (k < have ? ["-map", `0:a:${k}`] : ["-map", "1:a:0"])).flat();
      const picture = `setpts=(PTS-STARTPTS)/${speed},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}`;
      const sound = `${speed !== 1 ? `${tempo(speed)},` : ""}aresample=48000,aformat=channel_layouts=stereo`;
      await ff(
        ["-ss", s.from.toFixed(6), "-t", (s.length * speed).toFixed(6), "-i", s.path, ...silence, "-map", "0:v:0", ...maps, "-vf", picture, "-af", sound, "-t", s.length.toFixed(6), ...codec, "-c:a", "flac", "-sn", "-dn", path.join(dir, name)],
        { signal, total: s.length, onProgress: (p) => progress((done + p * s.length) / total, `Montando a gravação na ordem do editor (trecho ${i + 1} de ${segments.length})`) },
      );
      done += s.length;
      names.push(name);
    }
    fs.writeFileSync(path.join(dir, "lista.txt"), names.map((n) => `file '${n}'`).join("\n"));
    progress(0.99, "Juntando os trechos");
    await ff(["-f", "concat", "-safe", "0", "-i", "lista.txt", "-map", "0", "-c", "copy", out], { signal, cwd: dir });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { duration: total, tracks, bytes: fs.statSync(out).size };
}

module.exports = { flatten };

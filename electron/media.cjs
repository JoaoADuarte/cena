// Media inspection helpers built on bundled ffprobe/ffmpeg binaries.
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const unpacked = (p) => p.replace("app.asar", "app.asar.unpacked");
const FFMPEG = unpacked(require("ffmpeg-static"));
const FFPROBE = unpacked(require("ffprobe-static").path);

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"]);
const MICROS = 1_000_000;

/** Run a binary and collect stdout as a Buffer; rejects with stderr on non-zero exit. */
function run(bin, args, { maxBytes = 256 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    const chunks = [];
    let size = 0;
    let stderr = "";
    child.stdout.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) child.kill();
      else chunks.push(c);
    });
    child.stderr.on("data", (c) => (stderr = (stderr + c).slice(-4000)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`${path.basename(bin)} exited ${code}: ${stderr.trim()}`));
    });
  });
}

function parseRate(rate) {
  if (!rate || rate === "0/0") return null;
  const [n, d] = rate.split("/").map(Number);
  return d ? n / d : n;
}

async function probe(file) {
  const out = await run(FFPROBE, [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    file,
  ]);
  const info = JSON.parse(out.toString("utf8"));
  const streams = info.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const audio = streams.find((s) => s.codec_type === "audio");
  const isImage = IMAGE_EXT.has(path.extname(file).toLowerCase());
  const seconds = Number(info.format?.duration ?? video?.duration ?? audio?.duration ?? 0);
  const kind = isImage ? "image" : video ? "video" : audio ? "audio" : null;
  if (!kind) throw new Error("O arquivo não tem fluxo de vídeo nem de áudio.");

  // Rotated phone footage reports coded size; swap for display size.
  const rotation = Math.abs(Number(video?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? video?.tags?.rotate ?? 0));
  const swap = rotation === 90 || rotation === 270;
  return {
    kind,
    name: path.basename(file),
    path: file,
    duration: isImage ? 5 * MICROS : Math.round(seconds * MICROS),
    width: video ? (swap ? video.height : video.width) : undefined,
    height: video ? (swap ? video.width : video.height) : undefined,
    fps: video ? parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate) ?? undefined : undefined,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    audioTracks: streams.filter((s) => s.codec_type === "audio").length,
  };
}

/** Containers that take each audio codec as is, so separating a track is a copy, not a conversion. */
const COPY_INTO = {
  aac: ".m4a",
  mp3: ".mp3",
  opus: ".ogg",
  vorbis: ".ogg",
  flac: ".flac",
  pcm_s16le: ".wav",
  pcm_s24le: ".wav",
  pcm_s32le: ".wav",
  pcm_f32le: ".wav",
  pcm_u8: ".wav",
};

/**
 * Copies audio tracks 2..n of a recording into their own files (the first stays with the video,
 * which is all a <video> element plays). One read of the file for all tracks; codecs the browser
 * plays are copied as they are, anything else becomes AAC. Cached by file identity.
 */
async function extractAudioTracks(file, dir) {
  const info = JSON.parse((await run(FFPROBE, ["-v", "error", "-print_format", "json", "-show_streams", "-select_streams", "a", file])).toString("utf8"));
  const streams = info.streams ?? [];
  if (streams.length < 2) return [];
  const stat = await fsp.stat(file);
  const key = crypto.createHash("sha1").update(`${file}|${stat.size}|${stat.mtimeMs}`).digest("hex").slice(0, 12);
  await fsp.mkdir(dir, { recursive: true });
  const tracks = streams.slice(1).map((s, n) => {
    const ext = COPY_INTO[s.codec_name];
    const out = path.join(dir, `faixa-${key}-${n + 2}${ext ?? ".m4a"}`);
    return { index: n + 1, out, tmp: `${out}.tmp${ext ?? ".m4a"}`, codec: ext ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "192k"] };
  });
  const missing = tracks.filter((t) => !fs.existsSync(t.out));
  if (missing.length) {
    const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", file];
    for (const t of missing) args.push("-map", `0:a:${t.index}`, ...t.codec, t.tmp);
    try {
      await run(FFMPEG, args);
      for (const t of missing) await fsp.rename(t.tmp, t.out);
    } finally {
      for (const t of missing) await fsp.rm(t.tmp, { force: true });
    }
  }
  return tracks.map((t) => t.out);
}

/**
 * Loudness of a clip's audio over time: dBFS per `hop` seconds (RMS), mono at 8 kHz.
 * The renderer turns it into speech regions, silences, ducking curves and highlights.
 */
async function envelope(file, sourceStart, sourceDuration, hop = 0.05) {
  const rate = 8000;
  const pcm = await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error",
    "-ss", sourceStart.toFixed(6), "-t", sourceDuration.toFixed(6), "-i", file,
    "-vn", "-ac", "1", "-ar", String(rate), "-f", "s16le", "pipe:1",
  ], { maxBytes: 2 * 1024 * 1024 * 1024 });
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const size = Math.max(1, Math.round(rate * hop));
  const db = [];
  for (let i = 0; i < samples.length; i += size) {
    let sum = 0;
    const end = Math.min(samples.length, i + size);
    for (let j = i; j < end; j++) sum += (samples[j] / 32768) ** 2;
    const rms = Math.sqrt(sum / Math.max(1, end - i));
    db.push(Math.round(Math.max(-90, 20 * Math.log10(rms + 1e-9)) * 10) / 10);
  }
  return { hop, db };
}

/** Times (seconds into the given range) where the picture changes shot; `threshold` 0..1. */
function sceneChanges(file, sourceStart, sourceDuration, threshold = 0.3) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, [
      "-hide_banner", "-nostats",
      "-ss", sourceStart.toFixed(6), "-t", sourceDuration.toFixed(6), "-i", file,
      "-an", "-vf", `scale=320:-2,select='gt(scene,${threshold})',showinfo`, "-f", "null", "-",
    ], { windowsHide: true });
    const times = [];
    let buffer = "";
    let tail = "";
    child.stderr.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        const m = /Parsed_showinfo.*pts_time:\s*([\d.]+)/.exec(line);
        if (m) times.push(Number(m[1]));
        else tail = (tail + line + "\n").slice(-2000);
      }
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(times) : reject(new Error(`ffmpeg ${code}: ${tail.trim()}`))));
  });
}

async function thumbnail(file, atSeconds) {
  const jpg = await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error",
    "-ss", String(Math.max(0, atSeconds)),
    "-i", file,
    "-frames:v", "1",
    "-vf", "scale=240:-2",
    "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
  ]);
  return `data:image/jpeg;base64,${jpg.toString("base64")}`;
}

/** Peak envelope at `perSecond` buckets per second, normalized to 0..1. */
async function waveform(file, perSecond = 50) {
  const sampleRate = 8000;
  const pcm = await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error",
    "-i", file,
    "-vn", "-ac", "1", "-ar", String(sampleRate),
    "-f", "s16le", "pipe:1",
  ]);
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const bucket = Math.floor(sampleRate / perSecond);
  const peaks = [];
  let max = 1;
  for (let i = 0; i < samples.length; i += bucket) {
    let peak = 0;
    const end = Math.min(samples.length, i + bucket);
    for (let j = i; j < end; j++) {
      const v = Math.abs(samples[j]);
      if (v > peak) peak = v;
    }
    peaks.push(peak);
    if (peak > max) max = peak;
  }
  return { perSecond, peaks: peaks.map((p) => Math.round((p / max) * 1000) / 1000) };
}

module.exports = { FFMPEG, FFPROBE, run, probe, thumbnail, waveform, extractAudioTracks, envelope, sceneChanges };

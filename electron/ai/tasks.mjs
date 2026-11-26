// Model-backed tasks: automatic captions (Whisper), background removal (MODNet) and object
// removal (LaMa). Runs in a utility process so inference never blocks the window.
// Models are downloaded from Hugging Face on first use and cached in `CENA_MODELS`.
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { AutoModel, AutoProcessor, RawImage, env, pipeline } from "@huggingface/transformers";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const ort = require("onnxruntime-node");
const { FFMPEG } = require("../media.cjs");
const { audioMix, graphArgs } = require("../exporter.cjs");

const MODELS_DIR = process.env.CENA_MODELS ?? path.join(process.cwd(), ".models");
env.cacheDir = MODELS_DIR;
env.allowLocalModels = false;

const WHISPER = { fast: "onnx-community/whisper-base", accurate: "onnx-community/whisper-small", max: "onnx-community/whisper-large-v3-turbo" };
const MODNET = "Xenova/modnet";
const LAMA_URL = "https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx";
const LAMA_SIZE = 512;

// --- Helpers ------------------------------------------------------------------------------

/** Aggregates Hugging Face per-file download events into one byte counter. */
function downloadReporter(report, label) {
  const files = new Map();
  return (e) => {
    if (e.status !== "progress" || !e.total) return;
    files.set(e.file, { loaded: e.loaded, total: e.total });
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    report({ stage: "download", label, loaded, total });
  };
}

/** Spawn FFmpeg and collect stdout. */
function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", ...args], { windowsHide: true });
    const chunks = [];
    let stderr = "";
    child.stdout.on("data", (c) => chunks.push(c));
    child.stderr.on("data", (c) => (stderr = (stderr + c).slice(-4000)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg ${code}: ${stderr.trim()}`))));
  });
}

/** Read fixed-size frames from a stream, one at a time. */
async function* frames(stream, frameBytes) {
  let pending = [];
  let size = 0;
  for await (const chunk of stream) {
    pending.push(chunk);
    size += chunk.length;
    while (size >= frameBytes) {
      const all = Buffer.concat(pending);
      yield all.subarray(0, frameBytes);
      const rest = all.subarray(frameBytes);
      pending = rest.length ? [rest] : [];
      size = rest.length;
    }
  }
}

function writeAsync(stream, buf) {
  return new Promise((resolve, reject) => {
    if (stream.write(buf)) return resolve();
    const done = (err) => {
      stream.off("drain", done);
      stream.off("error", done);
      if (err) reject(err);
      else resolve();
    };
    stream.on("drain", done);
    stream.on("error", done);
  });
}

// --- Captions -----------------------------------------------------------------------------

const asrCache = new Map();
async function asrPipeline(quality, report) {
  const id = WHISPER[quality] ?? WHISPER.fast;
  if (!asrCache.has(id)) {
    const asr = await pipeline("automatic-speech-recognition", id, {
      // The large model's full-precision encoder is 2.4 GB; its 8-bit version keeps the download near 1 GB.
      dtype: { encoder_model: quality === "max" ? "q8" : "fp32", decoder_model_merged: "q8" },
      device: "cpu",
      progress_callback: downloadReporter(report, "Whisper"),
    });
    asrCache.set(id, asr);
  }
  return asrCache.get(id);
}

const SAMPLE_RATE = 16000;
const WINDOW = 28 * SAMPLE_RATE;

/** Index of the quietest 50 ms between `from` and `to`, so windows end in a pause rather than mid-word. */
function quietestPoint(pcm, from, to) {
  const step = SAMPLE_RATE / 20;
  let best = to;
  let bestEnergy = Number.POSITIVE_INFINITY;
  for (let i = Math.max(0, from); i + step <= to; i += step) {
    let e = 0;
    for (let j = i; j < i + step; j++) e += pcm[j] * pcm[j];
    if (e < bestEnergy) {
      bestEnergy = e;
      best = i + step / 2;
    }
  }
  return Math.round(best);
}

function rms(pcm) {
  let e = 0;
  for (let i = 0; i < pcm.length; i++) e += pcm[i] * pcm[i];
  return Math.sqrt(e / Math.max(1, pcm.length));
}

/**
 * Whisper's segment edges are loose (the first one usually starts at 0 even after a long pause).
 * Pull them in to the first and last 20 ms frames that carry voice.
 */
function trimToVoice(pcm, start, end) {
  const frame = SAMPLE_RATE / 50;
  const a = Math.floor(start * SAMPLE_RATE);
  const b = Math.min(pcm.length, Math.ceil(end * SAMPLE_RATE));
  const energies = [];
  for (let i = a; i + frame <= b; i += frame) energies.push(rms(pcm.subarray(i, i + frame)));
  if (!energies.length) return [start, end];
  const threshold = Math.max(0.01, Math.max(...energies) * 0.1);
  const first = energies.findIndex((e) => e > threshold);
  const last = energies.length - 1 - [...energies].reverse().findIndex((e) => e > threshold);
  if (first < 0) return [start, end];
  const voiceStart = (a + first * frame) / SAMPLE_RATE - 0.05;
  const voiceEnd = (a + (last + 1) * frame) / SAMPLE_RATE + 0.15;
  return [Math.max(start, voiceStart), Math.min(end, voiceEnd)];
}

// Whisper invents these credits over silence or music.
const HALLUCINATIONS = /amara\.org|legendas pela comunidade|subtitles by|transcri(?:ção|bed) by/i;

/**
 * Transcribe the mixed timeline audio. Returns segments in seconds on the timeline clock.
 * params: { audio: AudioClipJob[], duration: µs, language: "pt" | "en" | "es" | null, quality: "fast" | "accurate" }
 */
export async function transcribe(params, report) {
  report({ stage: "prepare", label: "Extraindo o áudio" });
  const mix = audioMix(params.audio, params.duration, 0);
  const graph = graphArgs(mix.filters);
  const raw = await ffmpeg([
    ...mix.inputs,
    ...graph.args,
    "-map", "[aout]", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "pipe:1",
  ]).finally(graph.cleanup);
  const pcm = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length - (raw.length % 4)));
  const asr = await asrPipeline(params.quality, report);
  const segments = [];
  for (let pos = 0; pos < pcm.length; ) {
    let end = Math.min(pcm.length, pos + WINDOW);
    if (end < pcm.length) end = quietestPoint(pcm, end - 4 * SAMPLE_RATE, end);
    const chunk = pcm.subarray(pos, end);
    if (rms(chunk) > 0.003) {
      const out = await asr(chunk, {
        ...(params.language ? { language: params.language } : {}),
        task: "transcribe",
        return_timestamps: true,
      });
      const offset = pos / SAMPLE_RATE;
      const length = chunk.length / SAMPLE_RATE;
      for (const c of out.chunks ?? []) {
        const text = c.text.trim();
        if (!text || HALLUCINATIONS.test(text)) continue;
        const start = Math.min(c.timestamp[0] ?? 0, length);
        const stop = Math.min(c.timestamp[1] ?? length, length);
        if (stop <= start) continue;
        const [s, e] = trimToVoice(pcm, offset + start, offset + stop);
        segments.push({ start: s, end: e, text });
      }
    }
    pos = end;
    report({ stage: "work", label: "Transcrevendo", done: pos / SAMPLE_RATE, total: pcm.length / SAMPLE_RATE });
  }
  return { segments };
}

// --- Background removal -------------------------------------------------------------------

let modnet = null;
async function loadModnet(report) {
  if (!modnet) {
    const progress_callback = downloadReporter(report, "MODNet");
    const processor = await AutoProcessor.from_pretrained(MODNET, { progress_callback });
    let model;
    try {
      model = await AutoModel.from_pretrained(MODNET, { dtype: "fp32", device: "dml", progress_callback });
    } catch {
      model = await AutoModel.from_pretrained(MODNET, { dtype: "fp32", device: "cpu", progress_callback });
    }
    modnet = { processor, model };
  }
  return modnet;
}

/** RGBA copy of an RGB frame whose alpha is MODNet's foreground matte. */
async function cutout(rgb, width, height, net) {
  const image = new RawImage(new Uint8ClampedArray(rgb.buffer, rgb.byteOffset, rgb.length), width, height, 3);
  const { pixel_values } = await net.processor(image);
  const { output } = await net.model({ input: pixel_values });
  const matte = await RawImage.fromTensor(output[0].mul(255).to("uint8")).resize(width, height);
  const rgba = Buffer.allocUnsafe(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += 3) {
    rgba[i * 4] = rgb[j];
    rgba[i * 4 + 1] = rgb[j + 1];
    rgba[i * 4 + 2] = rgb[j + 2];
    rgba[i * 4 + 3] = matte.data[i];
  }
  return rgba;
}

/** Fit inside 1920 px on the long side, with even dimensions for the encoder. */
function workingSize(width, height) {
  const k = Math.min(1, 1920 / Math.max(width, height));
  return [Math.max(2, Math.round((width * k) / 2) * 2), Math.max(2, Math.round((height * k) / 2) * 2)];
}

/**
 * params: { path, kind: "image" | "video", width, height, fps, sourceStart: s, sourceDuration: s, hasAudio, outPath }
 * Images become a PNG; video becomes a VP9 WebM with alpha (and the original audio as Opus).
 */
export async function removeBackground(params, report) {
  const net = await loadModnet(report);
  if (params.kind === "image") {
    report({ stage: "work", label: "Removendo o fundo", done: 0, total: 1 });
    const { data, info } = await sharp(params.path).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const rgba = await cutout(data, info.width, info.height, net);
    await sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(params.outPath);
    report({ stage: "work", label: "Removendo o fundo", done: 1, total: 1 });
    return { path: params.outPath, width: info.width, height: info.height };
  }

  const [w, h] = workingSize(params.width, params.height);
  const fps = params.fps || 30;
  const total = Math.max(1, Math.round(params.sourceDuration * fps));
  const range = ["-ss", params.sourceStart.toFixed(6), "-t", params.sourceDuration.toFixed(6)];
  const decoder = spawn(FFMPEG, [
    "-hide_banner", "-loglevel", "error", ...range, "-i", params.path,
    "-an", "-vf", `fps=${fps},scale=${w}:${h}`, "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
  ], { windowsHide: true });
  const encoder = spawn(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w}x${h}`, "-r", String(fps), "-i", "pipe:0",
    ...(params.hasAudio ? [...range, "-i", params.path, "-map", "0:v", "-map", "1:a:0", "-c:a", "libopus", "-b:a", "160k"] : []),
    "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-crf", "30", "-b:v", "0",
    "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-auto-alt-ref", "0",
    params.outPath,
  ], { windowsHide: true });
  let encoderError = "";
  encoder.stderr.on("data", (c) => (encoderError = (encoderError + c).slice(-4000)));
  decoder.stderr.on("data", () => {});
  const encoded = new Promise((resolve) => encoder.on("close", resolve));

  let done = 0;
  for await (const rgb of frames(decoder.stdout, w * h * 3)) {
    await writeAsync(encoder.stdin, await cutout(rgb, w, h, net));
    done++;
    report({ stage: "work", label: "Removendo o fundo", done, total });
  }
  encoder.stdin.end();
  const code = await encoded;
  if (code !== 0) throw new Error(`Falha ao gravar o vídeo: ${encoderError.trim()}`);
  if (done === 0) throw new Error("Nenhum quadro foi lido do vídeo.");
  return { path: params.outPath, width: w, height: h };
}

// --- Object removal -----------------------------------------------------------------------

let lama = null;
async function loadLama(report) {
  if (lama) return lama;
  const file = path.join(MODELS_DIR, "Carve", "LaMa-ONNX", "lama_fp32.onnx");
  if (!fs.existsSync(file)) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const res = await fetch(LAMA_URL);
    if (!res.ok || !res.body) throw new Error(`Falha ao baixar o modelo LaMa (HTTP ${res.status}).`);
    const total = Number(res.headers.get("content-length")) || 0;
    const tmp = `${file}.part`;
    const out = fs.createWriteStream(tmp);
    let loaded = 0;
    for await (const chunk of res.body) {
      loaded += chunk.length;
      await writeAsync(out, chunk);
      report({ stage: "download", label: "LaMa", loaded, total });
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    await fsp.rename(tmp, file);
  }
  report({ stage: "prepare", label: "Carregando o modelo" });
  // DirectML rejects this model's FFT MatMuls at run time, so LaMa stays on the CPU.
  lama = await ort.InferenceSession.create(file, { executionProviders: ["cpu"] });
  return lama;
}

/** Bounding box of mask pixels > 127, or null when nothing is painted. */
function maskBounds(mask, width, height) {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] > 127) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/**
 * Erase the painted area of an image. params: { path, maskPng: base64 PNG (white = remove), outPath }.
 * LaMa works on a fixed 512×512 square, so only a square around the mask is sent through it and the
 * result is blended back into the full-resolution image.
 */
export async function removeObjects(params, report) {
  const session = await loadLama(report);
  report({ stage: "work", label: "Removendo objetos", done: 0, total: 1 });
  const { data: image, info } = await sharp(params.path).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  // Grow the strokes a little so the model also replaces the object's soft edges.
  const mask = await sharp(Buffer.from(params.maskPng, "base64"))
    .resize(width, height, { fit: "fill" })
    .extractChannel(0)
    .blur(Math.max(1, Math.round(Math.max(width, height) / 400)))
    .threshold(20)
    .raw()
    .toBuffer();
  const bounds = maskBounds(mask, width, height);
  if (!bounds) throw new Error("Pinte sobre o que deseja remover.");

  // Square crop with context around the mask; LaMa needs surrounding texture to fill from.
  const side = Math.min(Math.max(width, height), Math.max(LAMA_SIZE / 2, Math.round(Math.max(bounds.x1 - bounds.x0, bounds.y1 - bounds.y0) * 2)));
  const cx = (bounds.x0 + bounds.x1) / 2;
  const cy = (bounds.y0 + bounds.y1) / 2;
  const cropW = Math.min(width, side);
  const cropH = Math.min(height, side);
  const left = Math.round(Math.min(Math.max(0, cx - cropW / 2), width - cropW));
  const top = Math.round(Math.min(Math.max(0, cy - cropH / 2), height - cropH));
  const region = { left, top, width: cropW, height: cropH };

  const imgSquare = await sharp(image, { raw: { width, height, channels: 3 } }).extract(region).resize(LAMA_SIZE, LAMA_SIZE, { fit: "fill" }).raw().toBuffer();
  // sharp widens single-channel raw input to three channels unless told otherwise.
  const maskSquare = await sharp(mask, { raw: { width, height, channels: 1 } }).extract(region).resize(LAMA_SIZE, LAMA_SIZE, { fit: "fill" }).extractChannel(0).raw().toBuffer();
  const n = LAMA_SIZE * LAMA_SIZE;
  const imgTensor = new Float32Array(3 * n);
  const maskTensor = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    imgTensor[i] = imgSquare[i * 3] / 255;
    imgTensor[n + i] = imgSquare[i * 3 + 1] / 255;
    imgTensor[2 * n + i] = imgSquare[i * 3 + 2] / 255;
    maskTensor[i] = maskSquare[i] > 127 ? 1 : 0;
  }
  const [imageName, maskName] = session.inputNames;
  const outputs = await session.run({
    [imageName]: new ort.Tensor("float32", imgTensor, [1, 3, LAMA_SIZE, LAMA_SIZE]),
    [maskName]: new ort.Tensor("float32", maskTensor, [1, 1, LAMA_SIZE, LAMA_SIZE]),
  });
  const result = outputs[session.outputNames[0]].data;
  // The model outputs 0..255; some exports output 0..1.
  let max = 0;
  for (let i = 0; i < result.length; i += 97) max = Math.max(max, result[i]);
  const scale = max <= 1.5 ? 255 : 1;
  const filled = Buffer.allocUnsafe(n * 3);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) filled[i * 3 + c] = Math.max(0, Math.min(255, Math.round(result[c * n + i] * scale)));
  }
  const patch = await sharp(filled, { raw: { width: LAMA_SIZE, height: LAMA_SIZE, channels: 3 } }).resize(cropW, cropH, { fit: "fill" }).raw().toBuffer();
  // Feathered blend keeps the untouched pixels at full resolution.
  const soft = await sharp(mask, { raw: { width, height, channels: 1 } }).extract(region).blur(2).extractChannel(0).raw().toBuffer();
  const out = Buffer.from(image);
  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) {
      const a = soft[y * cropW + x] / 255;
      if (a <= 0) continue;
      const o = ((top + y) * width + left + x) * 3;
      const p = (y * cropW + x) * 3;
      for (let c = 0; c < 3; c++) out[o + c] = Math.round(out[o + c] * (1 - a) + patch[p + c] * a);
    }
  }
  await sharp(out, { raw: { width, height, channels: 3 } }).png().toFile(params.outPath);
  report({ stage: "work", label: "Removendo objetos", done: 1, total: 1 });
  return { path: params.outPath, width, height };
}

// --- FFmpeg processing (reverse, noise reduction, enhancement) -------------------------------

/** Run FFmpeg reporting progress from its `-progress` output against the expected output length. */
function ffmpegWithProgress(args, totalSeconds, label, report) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-progress", "pipe:1", "-nostats", ...args], { windowsHide: true });
    let stderr = "";
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m) report({ stage: "work", label, done: Math.min(totalSeconds, Number(m[1]) / 1e6), total: totalSeconds });
      }
    });
    child.stderr.on("data", (c) => (stderr = (stderr + c).slice(-4000)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${stderr.trim()}`))));
  });
}

const rangeArgs = (p) => ["-ss", p.sourceStart.toFixed(6), "-t", p.sourceDuration.toFixed(6), "-i", p.path];

/** Reverse buffers every frame in memory, so very long clips are refused. */
const REVERSE_LIMIT = 180;

export async function reverse(params, report) {
  if (params.sourceDuration > REVERSE_LIMIT) throw new Error(`Inverter funciona em trechos de até ${REVERSE_LIMIT / 60} minutos; divida o clipe antes.`);
  const args = [...rangeArgs(params)];
  if (params.hasVideo) args.push("-vf", "reverse", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p");
  else args.push("-vn");
  if (params.hasAudio) args.push("-af", "areverse", "-c:a", "aac", "-b:a", "192k");
  else args.push("-an");
  await ffmpegWithProgress([...args, params.outPath], params.sourceDuration, "Invertendo", report);
  return { path: params.outPath };
}

export async function denoise(params, report) {
  // Spectral denoiser with noise tracking, plus a gentle high-pass for rumble.
  await ffmpegWithProgress(
    [...rangeArgs(params), "-vn", "-af", "highpass=f=70,afftdn=nr=18:nf=-30:tn=1", "-c:a", "aac", "-b:a", "192k", params.outPath],
    params.sourceDuration,
    "Reduzindo ruído",
    report,
  );
  return { path: params.outPath };
}

export async function enhance(params, report) {
  // Low resolutions are doubled (lanczos) up to 4K; everything gets light denoise and sharpening.
  const k = params.height < 1080 ? Math.min(2, 2160 / Math.max(1, params.height)) : 1;
  const w = Math.round((params.width * k) / 2) * 2;
  const h = Math.round((params.height * k) / 2) * 2;
  const vf = `hqdn3d=1.5:1.5:6:6,scale=${w}:${h}:flags=lanczos,unsharp=5:5:0.8:5:5:0`;
  await ffmpegWithProgress(
    [...rangeArgs(params), "-vf", vf, "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", ...(params.hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"]), params.outPath],
    params.sourceDuration,
    "Melhorando a qualidade",
    report,
  );
  return { path: params.outPath, width: w, height: h };
}

/**
 * Voice polish for commentary: rumble cut, noise reduction, less mud, more presence, softer "s",
 * steady level from a compressor, and a final loudness for speech (-16 LUFS).
 */
const VOICE_CHAIN = [
  "highpass=f=80",
  "afftdn=nr=14:nf=-35:tn=1",
  "equalizer=f=250:t=q:w=1.2:g=-2",
  "equalizer=f=3500:t=q:w=1:g=3",
  "deesser=i=0.4",
  "acompressor=threshold=-21dB:ratio=3.5:attack=8:release=160:makeup=2",
  "loudnorm=I=-16:TP=-1.5:LRA=7",
  "aresample=48000",
].join(",");

export async function voice(params, report) {
  await ffmpegWithProgress([...rangeArgs(params), "-vn", "-af", VOICE_CHAIN, "-c:a", "aac", "-b:a", "192k", params.outPath], params.sourceDuration, "Melhorando a voz", report);
  return { path: params.outPath };
}

// --- Word-level transcription of a whole file (studio) ------------------------------------------

// Word timings come from the decoder's attention, which only these exports carry.
const WHISPER_WORDS = {
  fast: "onnx-community/whisper-base_timestamped",
  accurate: "onnx-community/whisper-small_timestamped",
  max: "onnx-community/whisper-large-v3-turbo_timestamped",
};

const wordAsrCache = new Map();
async function wordPipeline(quality, device, report) {
  const id = WHISPER_WORDS[quality] ?? WHISPER_WORDS.accurate;
  const key = `${id}@${device}`;
  if (!wordAsrCache.has(key)) {
    const asr = await pipeline("automatic-speech-recognition", id, {
      // 8-bit weights are slow and inexact on the graphics card; on the processor they halve the work.
      dtype: device === "cpu" ? { encoder_model: quality === "max" ? "q8" : "fp32", decoder_model_merged: "q8" } : "fp32",
      device,
      progress_callback: downloadReporter(report, "Whisper"),
    });
    wordAsrCache.set(key, asr);
  }
  return wordAsrCache.get(key);
}

/**
 * Transcribe a file word by word, reading it in windows so an hour of audio never sits in memory.
 * params: { path, language: "pt" | "en" | … | null, quality, device: "auto" | "dml" | "cpu", from?: s, to?: s }
 * Returns { words: [{ start, end, text }], device } with times in seconds of the file.
 */
export async function transcribeFile(params, report) {
  report({ stage: "prepare", label: "Carregando o modelo" });
  let device = params.device === "cpu" ? "cpu" : "dml";
  let asr;
  try {
    asr = await wordPipeline(params.quality, device, report);
  } catch (err) {
    if (params.device === "dml") throw err;
    device = "cpu";
    asr = await wordPipeline(params.quality, device, report);
  }
  const from = params.from ?? 0;
  const decoder = spawn(
    FFMPEG,
    ["-hide_banner", "-loglevel", "error", ...(from ? ["-ss", String(from)] : []), ...(params.to ? ["-to", String(params.to)] : []), "-i", params.path, "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "pipe:1"],
    { windowsHide: true },
  );
  let decodeError = "";
  decoder.stderr.on("data", (c) => (decodeError = (decodeError + c).slice(-2000)));
  const total = Math.max(1, (params.to ?? params.duration ?? 0) - from);
  const words = [];
  let held = new Float32Array(0);
  let offset = 0; // samples already transcribed

  const run = async (pcm) => {
    if (rms(pcm) <= 0.003) return;
    let out;
    try {
      out = await asr(pcm, { ...(params.language ? { language: params.language } : {}), task: "transcribe", return_timestamps: "word" });
    } catch (err) {
      // The graphics card can refuse a model at run time; the processor always works.
      if (device === "cpu" || params.device === "dml") throw err;
      device = "cpu";
      asr = await wordPipeline(params.quality, device, report);
      out = await asr(pcm, { ...(params.language ? { language: params.language } : {}), task: "transcribe", return_timestamps: "word" });
    }
    if (HALLUCINATIONS.test(out.text ?? "")) return;
    const base = from + offset / SAMPLE_RATE;
    const length = pcm.length / SAMPLE_RATE;
    for (const c of out.chunks ?? []) {
      const text = c.text.trim();
      if (!text) continue;
      const start = Math.min(c.timestamp[0] ?? length, length);
      const end = Math.min(c.timestamp[1] ?? start + 0.3, length);
      words.push({ start: +(base + start).toFixed(3), end: +(base + Math.max(end, start + 0.02)).toFixed(3), text });
    }
  };

  const chunkBytes = SAMPLE_RATE * 4;
  for await (const second of frames(decoder.stdout, chunkBytes)) {
    const add = new Float32Array(second.buffer.slice(second.byteOffset, second.byteOffset + second.length));
    const joined = new Float32Array(held.length + add.length);
    joined.set(held);
    joined.set(add, held.length);
    held = joined;
    if (held.length < WINDOW) continue;
    const end = quietestPoint(held, held.length - 4 * SAMPLE_RATE, held.length);
    await run(held.subarray(0, end));
    offset += end;
    held = held.slice(end);
    report({ stage: "work", label: "Transcrevendo", done: Math.min(total, offset / SAMPLE_RATE), total });
  }
  if (held.length > SAMPLE_RATE / 4) await run(held);
  if (!offset && !held.length) throw new Error(`Não consegui ler o áudio: ${decodeError.trim() || "arquivo sem som"}`);
  report({ stage: "work", label: "Transcrevendo", done: total, total });
  return { words, device };
}

export const TASKS = { transcribe, transcribeFile, removeBackground, removeObjects, reverse, denoise, enhance, voice };

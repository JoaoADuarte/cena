/**
 * What happens on screen, second by second, measured on this computer (no tokens): how much the picture moves,
 * where the scene changes, where it is black or stands still, and how loud the game is. Together they make an
 * "action" score, so a silent stretch full of action is not mistaken for a dead one.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { FFMPEG } = require("../media.cjs");
const { ff } = require("./ffmpeg.cjs");

const W = 64;
const H = 36;
const RATE = 4; // pictures measured per second
const VERSION = 1;

/** Tiny grey pictures, RATE per second, straight from FFmpeg: decoding on the graphics card when there is one. */
function measurePicture(file, duration, { signal, onProgress, hwaccel = true }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Interrompido."));
    const args = ["-hide_banner", "-nostdin", ...(hwaccel ? ["-hwaccel", "auto"] : []), "-i", file, "-an", "-sn", "-dn", "-vf", `fps=${RATE},scale=${W}:${H}:flags=area,format=gray`, "-f", "rawvideo", "pipe:1"];
    const child = spawn(FFMPEG, args, { windowsHide: true });
    const size = W * H;
    const motion = [];
    const light = [];
    let previous = null;
    let pending = Buffer.alloc(0);
    let log = "";
    const stop = () => child.kill();
    signal?.addEventListener("abort", stop);
    child.stdout.on("data", (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= size) {
        const frame = pending.subarray(0, size);
        let diff = 0;
        let sum = 0;
        for (let i = 0; i < size; i++) {
          sum += frame[i];
          if (previous) diff += Math.abs(frame[i] - previous[i]);
        }
        motion.push(previous ? diff / size : 0);
        light.push(sum / size);
        previous = Buffer.from(frame);
        pending = pending.subarray(size);
        if (onProgress && motion.length % (RATE * 30) === 0) onProgress(Math.min(1, motion.length / RATE / Math.max(1, duration)));
      }
    });
    child.stderr.on("data", (c) => (log = (log + c).slice(-20_000)));
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted) return reject(new Error("Interrompido."));
      if (code !== 0 && hwaccel) return measurePicture(file, duration, { signal, onProgress, hwaccel: false }).then(resolve, reject);
      if (code !== 0) return reject(new Error(`FFmpeg falhou (${code}): ${log.trim().split(/\r?\n/).slice(-2).join(" ")}`));
      resolve({ motion, light });
    });
  });
}

/** Loudness of each second (RMS, dB), one measure per second so a two-hour log stays small. */
async function measureSound(file, duration, { signal, stream = null }) {
  const map = stream === null ? [] : ["-map", `0:a:${stream}`];
  const log = await ff(["-i", file, ...map, "-vn", "-af", "aresample=8000,asetnsamples=8000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level", "-f", "null", "-"], { signal });
  const perSecond = new Array(Math.ceil(duration)).fill(-70);
  let at = null;
  for (const line of log.split(/\r?\n/)) {
    const time = /pts_time:([\d.]+)/.exec(line);
    if (time) at = Math.floor(Number(time[1]) + 0.001);
    const level = /RMS_level=(-?[\d.]+|-inf)/.exec(line);
    if (level && at !== null && at < perSecond.length) perSecond[at] = level[1] === "-inf" ? -70 : Math.max(-70, Number(level[1]));
  }
  return perSecond;
}

/** Each value's place among all of them, 0 (lowest) to 1 (highest). */
function ranks(values) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length).fill(0);
  order.forEach(([, i], k) => (out[i] = values.length > 1 ? k / (values.length - 1) : 0));
  return out;
}

const smooth = (values, radius) => values.map((_, i) => {
  let sum = 0;
  let n = 0;
  for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j++) (sum += values[j]), n++;
  return sum / n;
});

/** Runs of seconds where `test` holds for at least `min` seconds. */
function runs(length, test, min) {
  const out = [];
  let start = null;
  for (let s = 0; s <= length; s++) {
    if (s < length && test(s)) start ??= s;
    else if (start !== null) {
      if (s - start >= min) out.push({ start, end: s });
      start = null;
    }
  }
  return out;
}

/**
 * Second-by-second picture and sound of a recording. `gameStream`: the audio track with only the game, when the
 * recording has one (its loudness says more than the mix, where voices dominate). Cached next to the transcript.
 */
async function analyse(file, duration, { dir, signal, gameStream = null, onProgress } = {}) {
  const cache = dir ? path.join(dir, "visual.json") : null;
  const stamp = fs.statSync(file).mtimeMs;
  if (cache) {
    try {
      const saved = JSON.parse(fs.readFileSync(cache, "utf8"));
      if (saved.version === VERSION && saved.source === stamp && saved.gameStream === gameStream) return saved;
    } catch {
      // Not measured yet.
    }
  }
  const started = Date.now();
  const picture = await measurePicture(file, duration, { signal, onProgress: (p) => onProgress?.(0.85 * p) });
  onProgress?.(0.86);
  const sound = await measureSound(file, duration, { signal, stream: gameStream }).catch((err) => {
    if (signal?.aborted) throw err;
    return new Array(Math.ceil(duration)).fill(-70);
  });
  const seconds = Math.max(1, Math.ceil(duration));
  const motion = [];
  const light = [];
  const cutsAt = [];
  for (let s = 0; s < seconds; s++) {
    const slice = picture.motion.slice(s * RATE, (s + 1) * RATE);
    const lum = picture.light.slice(s * RATE, (s + 1) * RATE);
    // The median change inside the second: camera motion and action, not a single scene cut.
    const sorted = [...slice].sort((a, b) => a - b);
    motion.push(sorted.length ? sorted[sorted.length >> 1] : 0);
    light.push(lum.length ? lum.reduce((a, b) => a + b, 0) / lum.length : 0);
    // A scene change: one jump far above the change around it.
    const peak = Math.max(0, ...slice);
    if (peak > 28 && peak > 4 * (sorted[sorted.length >> 1] || 1)) cutsAt.push(s);
  }
  const loud = sound.slice(0, seconds);
  while (loud.length < seconds) loud.push(-70);
  // Action: moving picture and loud game, each against the rest of this same recording.
  const motionRank = ranks(motion);
  const loudRank = ranks(loud);
  const score = smooth(motion.map((_, s) => 0.55 * motionRank[s] + 0.45 * loudRank[s]), 2).map((v) => +v.toFixed(3));
  const result = {
    version: VERSION,
    source: stamp,
    gameStream,
    took: Math.round((Date.now() - started) / 100) / 10,
    motion: motion.map((v) => +v.toFixed(2)),
    loud: loud.map((v) => +v.toFixed(1)),
    score,
    sceneCuts: cutsAt,
    black: runs(seconds, (s) => light[s] < 12, 1),
    // Still picture: menus, loading, results, waiting. Absolute, so a calm recording is not all "still".
    still: runs(seconds, (s) => motion[s] < 0.6 && light[s] >= 12, 4),
    action: runs(seconds, (s) => score[s] >= 0.75, 3),
  };
  if (cache) fs.writeFileSync(cache, JSON.stringify(result));
  return result;
}

/** Average action score over a stretch (seconds). */
function actionIn(visual, start, end) {
  const a = Math.max(0, Math.floor(start));
  const b = Math.min(visual.score.length, Math.ceil(end));
  if (b <= a) return 0;
  let sum = 0;
  for (let s = a; s < b; s++) sum += visual.score[s];
  return sum / (b - a);
}

/** Share of a stretch inside strong action. */
function actionShare(visual, start, end) {
  const length = Math.max(0.001, end - start);
  return visual.action.reduce((sum, r) => sum + Math.max(0, Math.min(end, r.end) - Math.max(start, r.start)), 0) / length;
}

module.exports = { analyse, actionIn, actionShare, RATE };

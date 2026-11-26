/** FFmpeg for the studio's agents: cancellable, with progress, and with the log (several filters report there). */
const { spawn } = require("node:child_process");
const { FFMPEG } = require("../media.cjs");
const { describeVideo } = require("../frameReader.cjs");

const sdrCache = new Map();
/**
 * Filters that turn a recording into ordinary BT.709 pictures: HDR games (PQ, BT.2020) tone-mapped, odd pixels
 * made square. Empty for ordinary footage. Without it frames of an HDR recording come out grey and flat.
 */
function sdrFilter(file) {
  if (!sdrCache.has(file)) sdrCache.set(file, describeVideo(file).then((info) => info?.prefilter ?? "").catch(() => ""));
  return sdrCache.get(file);
}
/** `vf` after the SDR filters of the file. */
const withSdr = (pre, vf) => (pre ? `${pre},${vf}` : vf);

/**
 * options: { signal, total: seconds of output expected, onProgress(fraction) }
 * Resolves with everything FFmpeg wrote to its log.
 */
function ff(args, { signal, total = 0, onProgress, cwd } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Interrompido."));
    const child = spawn(FFMPEG, ["-hide_banner", "-nostdin", "-y", ...(onProgress ? ["-progress", "pipe:1", "-nostats"] : []), ...args], { windowsHide: true, cwd });
    let log = "";
    let buffer = "";
    const stop = () => child.kill();
    signal?.addEventListener("abort", stop);
    child.stdout.on("data", (chunk) => {
      if (!onProgress || !total) return;
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m) onProgress(Math.min(1, Number(m[1]) / 1e6 / total));
      }
    });
    child.stderr.on("data", (chunk) => (log = (log + chunk).slice(-4_000_000)));
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted) reject(new Error("Interrompido."));
      else if (code === 0) resolve(log);
      else reject(new Error(`FFmpeg falhou (${code}): ${log.trim().split(/\r?\n/).slice(-3).join(" ")}`));
    });
  });
}

module.exports = { ff, sdrFilter, withSdr };

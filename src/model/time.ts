import type { Micros } from "./types";

export const SECOND: Micros = 1_000_000;

export const toSeconds = (t: Micros) => t / SECOND;
export const fromSeconds = (s: number): Micros => Math.round(s * SECOND);

export const frameDuration = (fps: number): Micros => SECOND / fps;

/** Snap a time to the nearest frame boundary. */
export const quantize = (t: Micros, fps: number): Micros => {
  const f = frameDuration(fps);
  return Math.round(Math.round(t / f) * f);
};

/** mm:ss:ff timecode. */
export function timecode(t: Micros, fps: number): string {
  const totalFrames = Math.round(toSeconds(Math.max(0, t)) * fps);
  const frames = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(m)}:${pad(s)}:${pad(frames)}`;
}

/** Short ruler/duration label like 1:05 or 0:03.5. */
export function shortTime(t: Micros): string {
  const s = toSeconds(t);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const sec = Number.isInteger(Math.round(rest * 10) / 10) ? String(Math.round(rest)).padStart(2, "0") : rest.toFixed(1).padStart(4, "0");
  return `${m}:${sec}`;
}

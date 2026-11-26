import type { CaptionSegment } from "../api";

/** Smallest time a caption stays on screen, in seconds. */
const MIN_SECONDS = 0.4;

/**
 * Break transcribed sentences into short on-screen captions of at most `maxWords` words.
 * Whisper only times whole segments, so each piece gets a share of the segment's time
 * proportional to its length in characters. Breaks prefer punctuation.
 */
export function splitCaptions(segments: CaptionSegment[], maxWords: number): CaptionSegment[] {
  const out: CaptionSegment[] = [];
  for (const seg of segments) {
    const words = seg.text.split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const pieces: string[][] = [];
    let current: string[] = [];
    for (const word of words) {
      current.push(word);
      const atPunctuation = /[.,!?;:…]$/.test(word) && current.length >= Math.ceil(maxWords / 2);
      if (current.length >= maxWords || atPunctuation) {
        pieces.push(current);
        current = [];
      }
    }
    if (current.length) {
      // Fold a lone trailing word into the previous caption rather than flashing it alone.
      if (current.length === 1 && pieces.length && pieces[pieces.length - 1].length < maxWords + 2) pieces[pieces.length - 1].push(...current);
      else pieces.push(current);
    }
    const chars = pieces.map((p) => p.join(" ").length);
    const totalChars = chars.reduce((a, b) => a + b, 0);
    const span = seg.end - seg.start;
    let t = seg.start;
    pieces.forEach((p, i) => {
      const length = (span * chars[i]) / totalChars;
      out.push({ start: t, end: t + length, text: p.join(" ") });
      t += length;
    });
  }
  // Keep captions in order, non-overlapping and readable.
  out.sort((a, b) => a.start - b.start);
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1];
    if (next && out[i].end > next.start) out[i].end = next.start;
    if (out[i].end - out[i].start < MIN_SECONDS) out[i].end = Math.min(out[i].start + MIN_SECONDS, next ? next.start : Number.POSITIVE_INFINITY);
  }
  return out.filter((c) => c.end > c.start);
}

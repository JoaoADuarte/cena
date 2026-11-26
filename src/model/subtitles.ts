import type { CaptionSegment } from "../api";
import type { Project } from "./types";
import { SECOND } from "./time";

/** "00:01:02,345" / "0:01:02.34" → seconds. */
function parseClock(text: string): number {
  const m = /(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?/.exec(text.trim());
  if (!m) return Number.NaN;
  const frac = m[4] ? Number(m[4]) / 10 ** m[4].length : 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac;
}

/** SubRip: numbered blocks of "start --> end" plus text lines. */
export function parseSrt(text: string): CaptionSegment[] {
  const out: CaptionSegment[] = [];
  for (const block of text.replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    const timeIndex = lines.findIndex((l) => l.includes("-->"));
    if (timeIndex < 0) continue;
    const [a, b] = lines[timeIndex].split("-->");
    const start = parseClock(a);
    const end = parseClock(b);
    // Drop simple HTML-style formatting tags (<i>, <b>, <font>).
    const content = lines
      .slice(timeIndex + 1)
      .join("\n")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (content && end > start) out.push({ start, end, text: content });
  }
  return out;
}

/** Advanced SubStation Alpha: "Dialogue:" lines from [Events], using the Format line's column order. */
export function parseAss(text: string): CaptionSegment[] {
  const out: CaptionSegment[] = [];
  let format = ["Layer", "Start", "End", "Style", "Name", "MarginL", "MarginR", "MarginV", "Effect", "Text"];
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (/^Format:/i.test(line)) format = line.slice(7).split(",").map((f) => f.trim());
    if (!/^Dialogue:/i.test(line)) continue;
    const fields = line.slice(9).split(",");
    // Text is the last column and may itself contain commas.
    const cols = [...fields.slice(0, format.length - 1), fields.slice(format.length - 1).join(",")];
    const get = (name: string) => cols[format.findIndex((f) => f.toLowerCase() === name.toLowerCase())] ?? "";
    const start = parseClock(get("Start"));
    const end = parseClock(get("End"));
    const content = get("Text")
      .replace(/\{[^}]*\}/g, "")
      .replace(/\\[Nn]/g, "\n")
      .replace(/\\h/g, " ")
      .trim();
    if (content && end > start) out.push({ start, end, text: content });
  }
  return out.sort((a, b) => a.start - b.start);
}

export function parseSubtitles(fileName: string, text: string): CaptionSegment[] {
  return /\.(ass|ssa)$/i.test(fileName) ? parseAss(text) : parseSrt(text);
}

const srtClock = (seconds: number) => {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
};

/** SubRip text of the project's caption tracks (or, without any, of every text clip). */
export function projectToSrt(project: Project): string {
  const captionTracks = project.tracks.filter((t) => t.role === "captions");
  const tracks = captionTracks.length ? captionTracks : project.tracks.filter((t) => t.kind === "text");
  const items = tracks
    .flatMap((t) => t.segments)
    .filter((s) => s.text?.content.trim())
    .sort((a, b) => a.start - b.start);
  return items.map((s, i) => `${i + 1}\n${srtClock(s.start / SECOND)} --> ${srtClock((s.start + s.duration) / SECOND)}\n${s.text!.content.trim()}\n`).join("\n");
}

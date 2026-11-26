/**
 * AI narration: a sentence the creator wrote, spoken by the AI voice, placed on the timeline. And the "narrated hook":
 * while the voice says the sentence, pieces of the video play behind it (muted, slower and a bit darker, with the
 * sentence on screen); then the real moment plays.
 */
import { oneUndoStep, useEditor } from "./store";
import { DEFAULT_TEXT, DEFAULT_TRANSFORM, createSegment, uid } from "./model/project";
import type { Micros, Project, Segment, Track } from "./model/types";

const SEC = 1_000_000;
const ed = () => useEditor.getState();
const end = (s: Segment) => s.start + s.duration;
const mainTrack = (p: Project): Track | undefined => [...p.tracks].reverse().find((t) => t.kind === "video");

export interface Spoken {
  materialId: string;
  path: string;
  duration: Micros;
}

/** Makes the voice and imports it into the project (not on the timeline yet). */
export async function speak(text: string, speed = 1): Promise<Spoken> {
  const path = await window.api.ttsSpeak(text, { speed });
  const [material] = await ed().importFiles([path]);
  if (!material) throw new Error("A voz foi gerada, mas não entrou no projeto.");
  const name = `Voz IA: ${text.replace(/\s+/g, " ").trim().slice(0, 40)}`;
  ed().mutate((p) => void (p.materials[material.id].name = name), { history: false });
  return { materialId: material.id, path, duration: material.duration };
}

/** The sentence on screen while the voice speaks: big, centred near the top, readable on a phone. */
function caption(p: Project, text: string, start: Micros, duration: Micros) {
  const vertical = p.height > p.width;
  return {
    start,
    duration,
    text: { ...DEFAULT_TEXT, content: text, fontFamily: "Impact", fontSize: Math.round(p.height * (vertical ? 0.045 : 0.07)), bold: false, strokeWidth: Math.round(p.height * 0.006), color: "#ffffff" },
    transform: { ...DEFAULT_TRANSFORM, y: vertical ? -0.55 : -0.62 },
  };
}

/** Breaks a sentence in lines of a few words, so it fits a vertical video. */
function wrap(text: string, perLine: number) {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += perLine) lines.push(words.slice(i, i + perLine).join(" "));
  return lines.join("\n");
}

/** Voice alone, at `start` (default: the playhead), on an audio track; optionally the sentence on screen. */
export async function addNarration(text: string, { start, speed = 1, captions = true }: { start?: Micros; speed?: number; captions?: boolean } = {}) {
  const at = start ?? ed().playhead;
  const voice = await speak(text, speed);
  return oneUndoStep(() => {
    const audioId = ed().addMaterialToTimeline(voice.materialId, { start: at });
    if (!audioId) throw new Error("Não consegui colocar a voz na linha do tempo.");
    let textId: string | null = null;
    if (captions) {
      const p = ed().project;
      [textId] = ed().insertOverlays([{ ...caption(p, wrap(text, p.height > p.width ? 3 : 6), at, voice.duration) }]);
    }
    return { audioId, textId, duration: voice.duration };
  });
}

export interface HookOptions {
  /** Where the hook goes on the timeline (default 0: the start of the video). Everything from here moves forward. */
  at?: Micros;
  /** Timeline ranges (before the hook goes in) whose picture plays behind the voice. Default: what comes right after `at`. */
  teaser?: [Micros, Micros][];
  /** Voice speed (1 = normal). */
  speed?: number;
  /** Speed of the pictures behind the voice (default 0.6: slower, like a preview). */
  teaserSpeed?: number;
  captions?: boolean;
}

/**
 * The narrated hook. Returns what it put in, with the moment the real scene starts (end of the hook).
 */
export async function narratedHook(text: string, options: HookOptions = {}) {
  const at = Math.max(0, options.at ?? 0);
  const slow = Math.min(1, Math.max(0.25, options.teaserSpeed ?? 0.6));
  const voice = await speak(text, options.speed ?? 1);
  // Everything below is one undo step.
  return oneUndoStep(() => placeHook(text, voice, at, slow, options));
}

function placeHook(text: string, voice: Spoken, at: Micros, slow: number, options: HookOptions) {
  const length = voice.duration + Math.round(0.35 * SEC);

  const before = ed().project;
  const main = mainTrack(before);
  if (!main?.segments.length) throw new Error("Coloque o vídeo na faixa principal antes de fazer o gancho.");
  // Pieces of the main track for each range (each piece inside one clip), then repeated until the voice ends.
  const ranges = options.teaser?.length ? options.teaser : [[at, at + Math.round(length * slow)] as [Micros, Micros]];
  const pieces: { seg: Segment; from: Micros; to: Micros }[] = [];
  for (const [a, b] of ranges) {
    for (const seg of [...main.segments].sort((x, y) => x.start - y.start)) {
      const from = Math.max(a, seg.start);
      const to = Math.min(b, end(seg));
      if (to - from >= 0.2 * SEC) pieces.push({ seg, from, to });
    }
  }
  if (!pieces.length) throw new Error("Não encontrei vídeo nesses trechos para rodar atrás da voz.");

  // Room for the hook: clips that cross `at` are cut there, then everything from `at` on moves forward.
  ed().select(null);
  ed().splitAt(at);
  const segments: Segment[] = [];
  let filled = 0;
  for (let i = 0; filled < length && i < 200; i++) {
    const { seg, from, to } = pieces[i % pieces.length];
    const duration = Math.min(length - filled, Math.round((to - from) / slow));
    if (duration < 0.05 * SEC) break;
    segments.push(
      createSegment({
        ...structuredClone(seg),
        id: uid("seg"),
        start: at + filled,
        duration,
        sourceStart: seg.sourceStart + Math.round((from - seg.start) * seg.speed),
        speed: seg.speed * slow,
        volume: 0,
        fadeIn: 0,
        fadeOut: 0,
        keyframes: {},
        transition: null,
        linkId: null,
        groupId: null,
        adjust: { ...seg.adjust, brightness: (seg.adjust?.brightness ?? 1) * 0.8, saturation: (seg.adjust?.saturation ?? 1) * 0.85 },
      }),
    );
    filled += duration;
  }
  const hookEnd = at + length;
  ed().mutate((p) => {
    for (const track of p.tracks) for (const s of track.segments) if (s.start >= at) s.start += length;
    for (const m of p.markers) if (m.time >= at) m.time += length;
    const track = mainTrack(p)!;
    track.segments.push(...segments);
    track.segments.sort((x, y) => x.start - y.start);
  });
  // The voice on its own audio track, and the sentence on screen.
  const audioId = ed().addMaterialToTimeline(voice.materialId, { start: at });
  let textId: string | null = null;
  if (options.captions !== false) {
    const p = ed().project;
    [textId] = ed().insertOverlays([caption(p, wrap(text, p.height > p.width ? 3 : 6), at, voice.duration)]);
  }
  ed().setPlayhead(at);
  return { audioId, textId, teaserIds: segments.map((s) => s.id), start: at, end: hookEnd, voiceDuration: voice.duration };
}

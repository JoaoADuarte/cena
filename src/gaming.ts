/**
 * Tools for gameplay videos: cut silences, duck the game under the commentary, find the loud
 * moments, mark shot changes, punch-in zooms and the vertical gameplay + facecam layout.
 * Audio decisions come from a loudness envelope (dBFS every 50 ms) measured by FFmpeg.
 */
import { oneUndoStep, useEditor } from "./store";
import { cropToAspect, findSegment, segmentEnd, sourceDuration, valueAt } from "./model/project";
import { SECOND } from "./model/time";
import type { Keyframe, Micros, Segment, Track } from "./model/types";

const HOP = 0.05;
const ed = () => useEditor.getState();

/** [start, end] in seconds. */
export type Range = [number, number];

function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))] ?? -90;
}

/** Merge ranges closer than `gap` seconds and drop ones shorter than `min`. */
function tidy(ranges: Range[], gap: number, min: number): Range[] {
  const out: Range[] = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && r[0] - last[1] < gap) last[1] = r[1];
    else out.push([r[0], r[1]]);
  }
  return out.filter(([a, b]) => b - a >= min);
}

/**
 * Where someone speaks (or anything rises clearly above the background), in seconds of the envelope.
 * The threshold adapts to the recording: 10 dB over its quiet floor, never below -50 dBFS.
 */
export function speechRanges(db: number[], hop = HOP): Range[] {
  if (!db.length) return [];
  const floor = percentile(db, 0.2);
  const loud = percentile(db, 0.95);
  const threshold = Math.min(Math.max(floor + 10, -50), loud - 6);
  const raw: Range[] = [];
  let start = -1;
  db.forEach((v, i) => {
    if (v > threshold && start < 0) start = i;
    if (v <= threshold && start >= 0) {
      raw.push([start * hop, i * hop]);
      start = -1;
    }
  });
  if (start >= 0) raw.push([start * hop, db.length * hop]);
  return tidy(raw, 0.35, 0.2);
}

/** The clip's sound over time, with converters from envelope seconds to timeline time. */
async function loudness(id: string) {
  const found = findSegment(ed().project, id);
  const material = found?.segment.materialId ? ed().project.materials[found.segment.materialId] : undefined;
  if (!found || !material) throw new Error(`Clipe não encontrado: ${id}.`);
  if (!material.hasAudio) throw new Error(`"${material.name}" não tem som.`);
  const s = found.segment;
  const env = await window.api.audioEnvelope(material.path, s.sourceStart / SECOND, sourceDuration(s) / SECOND, HOP);
  // The envelope runs on source time; the timeline plays it at the clip's speed.
  const toTimeline = (seconds: number): Micros => s.start + Math.round((seconds * SECOND) / s.speed);
  return { segment: s, track: found.track, material, db: env.db, hop: env.hop, toTimeline };
}

function requireClip(id: string) {
  const found = findSegment(ed().project, id);
  if (!found) throw new Error(`Clipe não encontrado: ${id}.`);
  if (found.track.locked) throw new Error(`A faixa "${found.track.name}" está bloqueada.`);
  return found;
}

// --- Silences ------------------------------------------------------------------------------

/**
 * Cut the pauses out of a clip with speech: every silence longer than `minSilence` goes, keeping
 * `padding` of breath on each side. Everything after each cut moves back, on every track.
 */
export async function removeSilences(id: string, { minSilence = 0.7, padding = 0.15 } = {}) {
  requireClip(id);
  const L = await loudness(id);
  const speech = speechRanges(L.db, L.hop);
  if (!speech.length) throw new Error("Não encontrei fala nem som acima do ruído neste clipe.");
  const total = L.db.length * L.hop;
  const gaps: Range[] = [];
  let cursor = 0;
  for (const [a, b] of speech) {
    gaps.push([cursor, a]);
    cursor = b;
  }
  gaps.push([cursor, total]);
  const cuts = gaps
    .filter(([a, b]) => b - a >= minSilence)
    .map(([a, b]): Range => [a === 0 ? 0 : a + padding, b >= total ? total : b - padding])
    .filter(([a, b]) => b - a > 0.05)
    .map(([a, b]) => [L.toTimeline(a), L.toTimeline(b)] as [Micros, Micros]);
  if (!cuts.length) return { cuts: 0, removedSeconds: 0 };
  const before = projectEnd();
  // Last to first, so earlier times stay valid.
  oneUndoStep(() => {
    for (const [a, b] of [...cuts].reverse()) ed().removeRange(a, b);
  });
  return { cuts: cuts.length, removedSeconds: Math.round((before - projectEnd()) / 1000) / 1000 };
}

const projectEnd = () => Math.max(0, ...ed().project.tracks.flatMap((t) => t.segments.map(segmentEnd)));

// --- Ducking -------------------------------------------------------------------------------

/**
 * Lower every other sound (game, music, chat) while the voice clip speaks: volume curves that dip to
 * `level` with an `attack` before each phrase and a `release` after it. Replaces earlier curves.
 */
export async function duckUnderVoice(voiceId: string, { level = 0.25, attack = 0.15, release = 0.5, targetIds }: { level?: number; attack?: number; release?: number; targetIds?: string[] } = {}) {
  requireClip(voiceId);
  const L = await loudness(voiceId);
  // Short breaths between phrases shouldn't make the music pump.
  const speech = tidy(speechRanges(L.db, L.hop), 1.0, 0.3).map(([a, b]) => [L.toTimeline(a), L.toTimeline(b)] as [Micros, Micros]);
  if (!speech.length) throw new Error("Não encontrei fala no clipe de voz.");
  const { project } = ed();
  const targets: { track: Track; segment: Segment }[] = [];
  for (const track of project.tracks) {
    if (track.kind === "text" || track.locked) continue;
    for (const segment of track.segments) {
      const m = segment.materialId ? project.materials[segment.materialId] : undefined;
      if (segment.id === voiceId || !m?.hasAudio || (targetIds && !targetIds.includes(segment.id))) continue;
      targets.push({ track, segment });
    }
  }
  const A = Math.round(attack * SECOND);
  const R = Math.round(release * SECOND);
  let ducked = 0;
  oneUndoStep(() => {
    for (const { segment } of targets) {
      const base = segment.volume;
      const frames: Keyframe[] = [];
      for (const [a, b] of speech) {
        if (b + R <= segment.start || a - A >= segmentEnd(segment)) continue;
        const la = a - segment.start;
        const lb = b - segment.start;
        frames.push({ time: la - A, value: base }, { time: la, value: base * level }, { time: lb, value: base * level }, { time: lb + R, value: base });
      }
      const clipped = frames.filter((k) => k.time >= 0 && k.time <= segment.duration);
      // A phrase already running at the clip's start begins ducked.
      if (frames.length && frames[0].time < 0 && clipped[0]?.value !== base) clipped.unshift({ time: 0, value: base * level });
      const unique = clipped.filter((k, i, all) => i === all.length - 1 || all[i + 1].time > k.time);
      if (!unique.length) continue;
      ed().updateSegment(segment.id, (s) => void (s.keyframes.volume = unique), { history: false });
      ducked++;
    }
  });
  return { phrases: speech.length, clipsDucked: ducked };
}

/** Remove volume curves (ducking) from clips. */
export function clearDucking(ids: string[]) {
  oneUndoStep(() => {
    for (const id of ids) ed().updateSegment(id, (s) => void delete s.keyframes.volume, { history: false });
  });
}

// --- Highlights and scenes -----------------------------------------------------------------

/** The longest clip with sound on the main video track: the gameplay, usually. */
export function mainGameplayClip(): string | null {
  const { project } = ed();
  const main = [...project.tracks].reverse().find((t) => t.kind === "video");
  const withSound = main?.segments.filter((s) => s.materialId && project.materials[s.materialId]?.hasAudio) ?? [];
  return withSound.sort((a, b) => b.duration - a.duration)[0]?.id ?? null;
}

/**
 * Mark the loudest stretches (fights, explosions, shouting) with markers: windows of `window`
 * seconds ranked by average loudness, at least three windows apart.
 */
export async function findHighlights(id?: string, { count = 6, window = 2.5 } = {}) {
  const clipId = id ?? mainGameplayClip();
  if (!clipId) throw new Error("Não há um clipe com som na faixa principal.");
  const L = await loudness(clipId);
  const size = Math.max(1, Math.round(window / L.hop));
  // Running sum over power, so loud bursts count more than steady noise.
  const power = L.db.map((v) => 10 ** (v / 10));
  const scores: number[] = [];
  let sum = 0;
  power.forEach((p, i) => {
    sum += p - (i >= size ? power[i - size] : 0);
    if (i >= size - 1) scores.push(10 * Math.log10(sum / size + 1e-12));
  });
  const order = scores.map((score, i) => ({ score, i })).sort((a, b) => b.score - a.score);
  const picked: { score: number; i: number }[] = [];
  for (const c of order) {
    if (picked.length >= count) break;
    if (picked.every((p) => Math.abs(p.i - c.i) >= size * 3)) picked.push(c);
  }
  picked.sort((a, b) => a.i - b.i);
  const moments = picked.map((p) => ({ start: L.toTimeline(p.i * L.hop), end: L.toTimeline((p.i + size) * L.hop), loudness: Math.round(p.score * 10) / 10 }));
  oneUndoStep(() => {
    moments.forEach((m, n) => {
      const markerId = ed().addMarker(m.start);
      ed().updateMarker(markerId, { label: `Destaque ${n + 1}`, color: "#ff5a36" });
    });
  });
  return { clipId, moments: moments.map((m) => ({ start: m.start / SECOND, end: m.end / SECOND, loudnessDb: m.loudness })) };
}

/** Find shot changes in a video clip and mark them, or split the clip there. */
export async function detectScenes(id: string, { threshold = 0.3, split = false } = {}) {
  const { segment: s } = requireClip(id);
  const material = s.materialId ? ed().project.materials[s.materialId] : undefined;
  if (!material?.hasVideo || material.kind === "image") throw new Error("Escolha um clipe de vídeo.");
  const changes = await window.api.sceneChanges(material.path, s.sourceStart / SECOND, sourceDuration(s) / SECOND, threshold);
  const margin = SECOND / 5;
  const times = changes.map((t) => s.start + Math.round((t * SECOND) / s.speed)).filter((t) => t > s.start + margin && t < segmentEnd(s) - margin);
  if (!times.length) return { scenes: 1, times: [] };
  oneUndoStep(() => {
    if (split) {
      // Right to left: the original clip keeps the left part, so its id stays valid for every cut.
      for (const t of [...times].reverse()) ed().splitAt(t, id);
    } else {
      times.forEach((t, n) => {
        const markerId = ed().addMarker(t);
        ed().updateMarker(markerId, { label: `Cena ${n + 2}`, color: "#4ea1ff" });
      });
    }
  });
  return { scenes: times.length + 1, times: times.map((t) => t / SECOND) };
}

// --- Visual --------------------------------------------------------------------------------

/** A quick zoom on the action at `time`: in fast, hold, back out. Keeps the clip's other scale animation. */
export function punchZoom(id: string, time: Micros, { amount = 1.3, hold = 0.6 } = {}) {
  const { segment: s } = requireClip(id);
  const local = time - s.start;
  if (local < 0 || local >= s.duration) throw new Error("O momento do zoom precisa estar dentro do clipe.");
  const inT = Math.round(0.12 * SECOND);
  const outT = Math.round(0.3 * SECOND);
  const holdT = Math.round(hold * SECOND);
  const end = Math.min(s.duration, local + inT + holdT + outT);
  const base = valueAt(s, "scale", local);
  const after = valueAt(s, "scale", end);
  const kept = (s.keyframes.scale ?? []).filter((k) => k.time < local - 1 || k.time > end + 1);
  const frames: Keyframe[] = [
    ...kept,
    { time: local, value: base, easing: "easeOut" },
    { time: Math.min(end, local + inT), value: base * amount },
    { time: Math.min(end, local + inT + holdT), value: base * amount, easing: "easeInOut" },
    { time: end, value: after },
  ];
  frames.sort((a, b) => a.time - b.time);
  ed().updateSegment(id, (seg) => void (seg.keyframes.scale = frames.filter((k, i, all) => i === all.length - 1 || all[i + 1].time > k.time)));
  return { clipId: id, time: time / SECOND, amount };
}

/**
 * Vertical (1080×1920) for Shorts, TikTok and Reels. With a facecam: camera on the top third,
 * gameplay below, each cropped to fit. Without: the gameplay centered over its own blurred copy.
 * Applies to every clip of the same media, so a gameplay cut into pieces keeps one look.
 */
export function verticalGamingLayout(gameplayId: string, facecamId?: string) {
  const game = requireClip(gameplayId).segment;
  const cam = facecamId ? requireClip(facecamId).segment : null;
  const W = 1080;
  const H = 1920;
  const camH = 640;
  oneUndoStep(() =>
    ed().mutate((p) => {
      p.width = W;
      p.height = H;
      p.backgroundMode = cam ? "color" : "blur";
      if (cam) p.background = "#000000";
      const place = (materialId: string | null, aspect: number | null, y: number) => {
        const m = materialId ? p.materials[materialId] : undefined;
        if (!m) return;
        for (const t of p.tracks)
          for (const s of t.segments) {
            if (s.materialId !== materialId) continue;
            s.crop = cropToAspect(m.width ?? W, m.height ?? H, aspect);
            s.transform = { ...s.transform, x: 0, y, scale: 1 };
            for (const prop of ["x", "y", "scale"] as const) delete s.keyframes[prop];
          }
      };
      if (cam) {
        // Contain-fit at scale 1: the gameplay fills 1080×1280 at the bottom, the camera 1080×640 on top.
        place(game.materialId, W / (H - camH), (H - (H - camH) / 2 - H / 2) / (H / 2));
        place(cam.materialId, W / camH, (camH / 2 - H / 2) / (H / 2));
      } else place(game.materialId, null, 0);
    }),
  );
  return { width: W, height: H, facecam: Boolean(cam) };
}

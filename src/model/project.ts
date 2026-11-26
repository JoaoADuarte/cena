import type {
  Adjust,
  AnimatableProp,
  ChannelId,
  Crop,
  Easing,
  Keyframe,
  Mask,
  MaskType,
  Material,
  Micros,
  Project,
  Segment,
  TextStyle,
  Track,
  TrackKind,
  Transform,
} from "./types";
import { SECOND } from "./time";

let counter = 0;
export const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const DEFAULT_TEXT: TextStyle = {
  content: "Seu texto",
  fontFamily: "Segoe UI",
  fontSize: 96,
  color: "#ffffff",
  bold: true,
  italic: false,
  align: "center",
  strokeColor: "#000000",
  strokeWidth: 6,
  background: null,
};

export const DEFAULT_TRANSFORM: Transform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
export const DEFAULT_ADJUST: Adjust = { brightness: 1, contrast: 1, saturation: 1, blur: 0, temperature: 0, tint: 0, sharpen: 0 };
export const DEFAULT_CROP: Crop = { left: 0, top: 0, right: 0, bottom: 0 };
export const DEFAULT_EFFECT_INTENSITY = 1;

/** Centered crop of a w×h frame to the given aspect ratio (null = no crop). */
export function cropToAspect(w: number, h: number, aspect: number | null): Crop {
  if (!aspect || !w || !h) return { ...DEFAULT_CROP };
  const current = w / h;
  if (current > aspect) {
    const cut = (1 - aspect / current) / 2;
    return { left: cut, right: cut, top: 0, bottom: 0 };
  }
  const cut = (1 - current / aspect) / 2;
  return { left: 0, right: 0, top: cut, bottom: cut };
}

export function createProject(name = "Novo projeto"): Project {
  return {
    version: 1,
    id: uid("prj"),
    name,
    width: 1920,
    height: 1080,
    fps: 30,
    background: "#000000",
    backgroundMode: "color",
    backgroundBlur: 40,
    markers: [],
    materials: {},
    tracks: [createTrack("video", "Principal")],
  };
}

export function createTrack(kind: TrackKind, name?: string): Track {
  const label = { video: "Vídeo", audio: "Áudio", text: "Texto" }[kind];
  return { id: uid("trk"), kind, name: name ?? label, muted: false, hidden: false, locked: false, segments: [] };
}

export function createSegment(partial: Partial<Segment> & Pick<Segment, "start" | "duration">): Segment {
  return {
    id: uid("seg"),
    materialId: null,
    text: null,
    sourceStart: 0,
    speed: 1,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    transform: { ...DEFAULT_TRANSFORM },
    adjust: { ...DEFAULT_ADJUST },
    crop: { ...DEFAULT_CROP },
    keyframes: {},
    transition: null,
    effects: [],
    blend: "normal",
    mask: null,
    shape: null,
    sticker: null,
    keepPitch: true,
    filter: null,
    flipX: false,
    flipY: false,
    linkId: null,
    adjustLayer: false,
    ...partial,
  };
}

export function createMask(type: MaskType): Mask {
  const square = ["star", "heart", "diamond"].includes(type);
  return {
    type,
    x: 0,
    y: 0,
    width: square ? 0.5 : type === "bars" ? 1 : 0.6,
    height: type === "bars" ? 0.6 : square ? 0.5 * (16 / 9) : 0.6,
    rotation: 0,
    feather: 0.02,
    roundness: 0,
    invert: false,
    text: "CENA",
    points: [],
  };
}

/** Fill fields added after a project file was written, so older .cena files keep loading. */
export function normalizeProject(project: Project): Project {
  const defaults = createProject();
  project.backgroundMode ??= defaults.backgroundMode;
  project.backgroundBlur ??= defaults.backgroundBlur;
  project.markers ??= [];
  for (const track of project.tracks) {
    track.segments = track.segments.map((s) => ({
      ...createSegment({ start: s.start, duration: s.duration }),
      ...s,
      transition: s.transition ?? null,
      effects: s.effects ?? [],
      adjust: { ...DEFAULT_ADJUST, ...s.adjust },
    }));
  }
  return project;
}

export function segmentForMaterial(material: Material, start: Micros): Segment {
  return createSegment({
    materialId: material.id,
    start,
    duration: material.duration,
  });
}

export const trackKindFor = (material: Material): TrackKind => (material.kind === "audio" ? "audio" : "video");

export const segmentEnd = (s: Segment) => s.start + s.duration;

export function projectDuration(project: Project): Micros {
  let end = 0;
  for (const t of project.tracks) for (const s of t.segments) end = Math.max(end, segmentEnd(s));
  return end;
}

/** Source media consumed by a segment, accounting for speed. */
export const sourceDuration = (s: Segment): Micros => Math.round(s.duration * s.speed);

/** Maximum timeline duration a segment may have given its material length. */
export function maxDuration(s: Segment, material: Material | undefined): Micros {
  if (!material || material.kind === "image") return Number.POSITIVE_INFINITY;
  return Math.floor((material.duration - s.sourceStart) / s.speed);
}

export const isActiveAt = (s: Segment, t: Micros) => t >= s.start && t < segmentEnd(s);

export function findSegment(project: Project, segmentId: string): { track: Track; segment: Segment; index: number } | null {
  for (const track of project.tracks) {
    const index = track.segments.findIndex((s) => s.id === segmentId);
    if (index >= 0) return { track, segment: track.segments[index], index };
  }
  return null;
}

export const overlaps = (a: { start: Micros; duration: Micros }, b: { start: Micros; duration: Micros }) =>
  a.start < b.start + b.duration && b.start < a.start + a.duration;

/** True if [start, start+duration) is free on the track, ignoring one segment id. */
export function isFree(track: Track, start: Micros, duration: Micros, ignoreId?: string): boolean {
  return track.segments.every((s) => s.id === ignoreId || !overlaps(s, { start, duration }));
}

/** Nearest start >= 0 on `track` where a clip of `duration` fits; falls back to after the last clip. */
export function nearestFreeStart(track: Track, desired: Micros, duration: Micros, ignoreId?: string): Micros {
  const desiredStart = Math.max(0, desired);
  if (isFree(track, desiredStart, duration, ignoreId)) return desiredStart;
  const candidates = [0];
  for (const s of track.segments) {
    if (s.id === ignoreId) continue;
    candidates.push(segmentEnd(s), s.start - duration);
  }
  let best: Micros | null = null;
  for (const c of candidates) {
    if (c < 0 || !isFree(track, c, duration, ignoreId)) continue;
    if (best === null || Math.abs(c - desiredStart) < Math.abs(best - desiredStart)) best = c;
  }
  return best ?? Math.max(0, ...track.segments.filter((s) => s.id !== ignoreId).map(segmentEnd));
}

export const sortSegments = (track: Track) => track.segments.sort((a, b) => a.start - b.start);

export const EASING_PRESETS: Record<Exclude<Easing, unknown[]>, [number, number, number, number] | null> = {
  linear: [0, 0, 1, 1],
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
  hold: null,
};

/** Bezier control points for an easing (null for "hold"). */
export function easingCurve(easing: Easing | undefined): [number, number, number, number] | null {
  if (!easing) return EASING_PRESETS.linear;
  return Array.isArray(easing) ? easing : EASING_PRESETS[easing];
}

/** Progress (0..1) along a cubic-bezier timing curve at time fraction `x`, like CSS cubic-bezier(). */
export function bezierAt([x1, y1, x2, y2]: [number, number, number, number], x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const coord = (t: number, p1: number, p2: number) => 3 * (1 - t) * (1 - t) * t * p1 + 3 * (1 - t) * t * t * p2 + t * t * t;
  // x(t) is monotonic for x1, x2 in [0, 1], so bisection always converges.
  let lo = 0;
  let hi = 1;
  let t = x;
  for (let i = 0; i < 30; i++) {
    t = (lo + hi) / 2;
    if (coord(t, x1, x2) < x) lo = t;
    else hi = t;
  }
  return coord(t, y1, y2);
}

/** Value of a channel when it has no keyframes. */
export function channelBase(segment: Segment, channel: ChannelId): number {
  if (channel === "volume") return segment.volume;
  if (channel.startsWith("fx:")) return segment.effects.find((e) => `fx:${e.id}` === channel)?.intensity ?? 0;
  return segment.transform[channel as AnimatableProp];
}

/** Set the static value of a channel (used when it has no keyframes). */
export function setChannelBase(segment: Segment, channel: ChannelId, value: number) {
  if (channel === "volume") segment.volume = value;
  else if (channel.startsWith("fx:")) {
    const effect = segment.effects.find((e) => `fx:${e.id}` === channel);
    if (effect) effect.intensity = value;
  } else segment.transform[channel as AnimatableProp] = value;
}

/** Interpolated value of an animated channel at segment-local time, following each keyframe's easing. */
export function valueAt(segment: Segment, channel: ChannelId, local: Micros): number {
  const frames = segment.keyframes[channel];
  if (!frames || frames.length === 0) return channelBase(segment, channel);
  if (local <= frames[0].time) return frames[0].value;
  const last = frames[frames.length - 1];
  if (local >= last.time) return last.value;
  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i];
    const b = frames[i + 1];
    if (local >= a.time && local <= b.time) {
      const k = b.time === a.time ? 0 : (local - a.time) / (b.time - a.time);
      const curve = easingCurve(a.easing);
      if (!curve) return a.value;
      return a.value + (b.value - a.value) * bezierAt(curve, k);
    }
  }
  return channelBase(segment, channel);
}

/** Keyframe within half a frame of `local`, if any. */
export function keyframeNear(frames: Keyframe[] | undefined, local: Micros, fps: number): Keyframe | undefined {
  const tolerance = SECOND / fps / 2;
  return frames?.find((k) => Math.abs(k.time - local) <= tolerance);
}

/** Opacity/gain multiplier from fade-in/out at segment-local time. */
export function fadeFactor(segment: Segment, local: Micros): number {
  let f = 1;
  if (segment.fadeIn > 0 && local < segment.fadeIn) f = Math.min(f, local / segment.fadeIn);
  const remaining = segment.duration - local;
  if (segment.fadeOut > 0 && remaining < segment.fadeOut) f = Math.min(f, remaining / segment.fadeOut);
  return Math.max(0, Math.min(1, f));
}

/** Gain at segment-local time: the volume (animated or not) times the fades. */
export const gainAt = (segment: Segment, local: Micros) => valueAt(segment, "volume", local) * fadeFactor(segment, local);

/** Two clips touch when the gap between them is under a millisecond. */
const ADJACENT_TOLERANCE: Micros = 1000;

/** The clip that starts where `segments[index]` ends, if any (segments must be sorted). */
export function nextAdjacent(track: Track, index: number): Segment | null {
  const a = track.segments[index];
  const b = track.segments[index + 1];
  return a && b && Math.abs(b.start - segmentEnd(a)) <= ADJACENT_TOLERANCE ? b : null;
}

export interface TransitionWindow {
  a: Segment;
  b: Segment;
  cut: Micros;
  start: Micros;
  end: Micros;
}

/** Longest transition two clips allow; centered on the cut it then uses at most half of each clip, so a clip's in and out windows never overlap. */
export const maxTransitionDuration = (a: Segment, b: Segment): Micros => Math.min(a.duration, b.duration);

/** Active window of the outgoing transition of `segments[index]`, centered on the cut. */
export function transitionWindow(track: Track, index: number): TransitionWindow | null {
  const a = track.segments[index];
  if (!a?.transition || track.kind !== "video") return null;
  const b = nextAdjacent(track, index);
  if (!b) return null;
  const d = Math.min(a.transition.duration, maxTransitionDuration(a, b));
  if (d <= 0) return null;
  const cut = segmentEnd(a);
  return { a, b, cut, start: cut - d / 2, end: cut + d / 2 };
}

/** Timeline range during which a clip contributes frames, including transition overlap. */
export function visibleRange(track: Track, index: number): [Micros, Micros] {
  const s = track.segments[index];
  const before = index > 0 ? transitionWindow(track, index - 1) : null;
  const after = transitionWindow(track, index);
  return [before ? before.start : s.start, after ? after.end : segmentEnd(s)];
}

/** Drop keyframes outside [0, duration] after a trim, shifting by `shift` first. */
export function retimeKeyframes(segment: Segment, shift: Micros) {
  for (const prop of Object.keys(segment.keyframes) as ChannelId[]) {
    const kept = (segment.keyframes[prop] ?? [])
      .map((k) => ({ ...k, time: k.time - shift }))
      .filter((k) => k.time >= 0 && k.time <= segment.duration);
    if (kept.length) segment.keyframes[prop] = kept;
    else delete segment.keyframes[prop];
  }
}

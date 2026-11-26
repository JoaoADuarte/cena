import { create } from "zustand";
import type { CaptionSegment } from "./api";
import type { Marker } from "./model/types";
import { ensureProjectFonts } from "./fonts";
import { DEFAULT_TRANSITION_SHAPE } from "./engine/catalog";
import type { AnimatableProp, ChannelId, Easing, EffectType, Material, MediaPreview, Micros, Project, Segment, Track, TrackKind, Transition, TransitionType } from "./model/types";
import {
  DEFAULT_EFFECT_INTENSITY,
  DEFAULT_TEXT,
  DEFAULT_TRANSFORM,
  createProject,
  createSegment,
  createTrack,
  findSegment,
  isFree,
  keyframeNear,
  maxDuration,
  nearestFreeStart,
  nextAdjacent,
  normalizeProject,
  overlaps,
  projectDuration,
  retimeKeyframes,
  segmentEnd,
  segmentForMaterial,
  setChannelBase,
  sortSegments,
  trackKindFor,
  uid,
  valueAt,
} from "./model/project";
import { SECOND, quantize } from "./model/time";

const HISTORY_LIMIT = 100;
/** Timeline zoom, in pixels per second: from hours in one screen down to single frames. */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 6000;
/** Chromium cannot lay out elements much wider than this. */
const MAX_TIMELINE_PX = 30_000_000;
const MIN_SEGMENT: Micros = SECOND / 10;
export const DEFAULT_TRANSITION: Micros = SECOND / 2;

export interface EditorState {
  project: Project;
  projectPath: string | null;
  dirty: boolean;
  previews: Record<string, MediaPreview>;
  selectedId: string | null;
  playhead: Micros;
  playing: boolean;
  pxPerSecond: number;
  past: Project[];
  future: Project[];
  status: string | null;

  /** Snapshot the current project into undo history (call once at the start of a drag). */
  checkpoint(): void;
  /** Apply a mutation to a deep copy of the project; `history: false` skips the undo snapshot. */
  mutate(fn: (draft: Project) => void, options?: { history?: boolean }): void;
  undo(): void;
  redo(): void;
  newProject(): void;
  loadProject(project: Project, path: string | null): void;
  markSaved(path: string): void;
  setStatus(text: string | null): void;

  importFiles(paths: string[]): Promise<Material[]>;
  /**
   * `sourceStart`/`duration` place only a part of the media instead of all of it. `overlay` puts video
   * on the topmost video track with room (a new one if needed), over the main track: for graphics with transparency.
   */
  addMaterialToTimeline(materialId: string, at?: { trackId?: string; start?: Micros; sourceStart?: Micros; duration?: Micros; overlay?: boolean; newTrack?: boolean }): string | null;
  /** An empty track the creator asked for ("+ Faixa"): pictures on top, sound at the bottom. Returns its id. */
  addTrack(kind: TrackKind): string;
  /** Remove media from the project, with every clip that uses it (one undo step). Returns how many clips went. */
  removeMaterials(ids: string[]): number;
  addText(start?: Micros): string;
  /** Add an overlay clip (shape, sticker, adjustment layer…) at the playhead, 3 s long unless given. */
  addOverlay(content: Partial<Segment>, start?: Micros): string;
  /** Add several overlay clips at once (one undo step), each on a free overlay track. Returns their ids. */
  insertOverlays(items: (Partial<Segment> & { start: Micros; duration: Micros })[]): string[];
  /** Put captions (seconds) on a new caption track, optionally replacing earlier ones. Returns how many were added. */
  addCaptions(lines: CaptionSegment[], replace: boolean): number;
  /** Swap a clip's media for an AI-processed version, keeping its place on the timeline. */
  replaceMaterial(segmentId: string, material: Material, sourceStart: Micros): void;
  /** Undo `replaceMaterial`, going back to the material it was derived from. */
  restoreOriginal(segmentId: string): void;
  moveSegment(id: string, start: Micros, trackId: string): void;
  /**
   * Drags one clip to `start` on track `target` ("new": a new track of its kind), with `others` (its linked audio,
   * its group) moving by the same time on their own tracks. Returns the track it landed on, or null.
   */
  moveClip(id: string, start: Micros, target: string | "new", others: string[], options?: { stack?: boolean }): string | null;
  /** Tracks left empty after a drag go away (the main track always stays). */
  dropEmptyTracks(): void;
  /** Deletes a whole track with its clips. */
  removeTrack(trackId: string): void;
  /** Put a track at `index` in the stack (0 is on top). Audio tracks stay below the picture tracks. */
  moveTrack(trackId: string, index: number): void;
  /** Shift several clips by the same amount, each on its own track; no-op if any would overlap. */
  moveSegments(ids: string[], delta: Micros): void;
  /**
   * Delete clips; with ripple, later clips on the same track move back to close the gap. When a clip leaves the main
   * track and the gap closes (ripple, or `magnet` on), every other track closes up with it: texts, sounds, images
   * and markers stay on the moments they were placed on.
   */
  deleteSegments(ids: string[], ripple: boolean, magnet?: boolean): void;
  /** Copy clips to the in-app clipboard; returns how many. */
  copySegments(ids: string[]): number;
  /** Paste the clipboard at `at`, keeping relative positions; returns the new ids. */
  pasteSegments(at: Micros): string[];
  /** Apply the first copied clip's animation, effects, adjustments, crop, mask and blend to other clips. */
  pasteAttributes(ids: string[]): number;
  /** Make clips one group (selected, moved and deleted together). Needs two or more; returns the group id. */
  groupSegments(ids: string[]): string | null;
  /** Take clips out of their groups; returns how many left one. */
  ungroupSegments(ids: string[]): number;
  /** Several clips selected at once: the first is the main selection (the inspector shows it). */
  selectMany(ids: string[]): void;
  /** Move a video clip's sound to its own audio clip (the video is muted). Returns the audio clip id. */
  detachAudio(id: string): string | null;
  /** Trim the clip's part left or right of the playhead (CapCut's Q/W). */
  deleteToPlayhead(id: string, side: "left" | "right", magnet?: boolean): boolean;
  /** Split at the playhead and insert a still image of `duration`, pushing the rest of the track right. */
  insertFreezeFrame(id: string, material: Material, duration: Micros): string | null;
  flip(ids: string[], axis: "x" | "y"): void;
  rotate90(ids: string[]): void;
  /** Close every gap on the main (bottom) video track. */
  /**
   * Closes the gaps the last edit opened on the main track. Gaps the creator left on purpose (a clip or group dropped
   * in empty space, black in between) stay: `before` is the project before the edit, and each clip keeps the gap it
   * had in front of it there. Clips in `anchor` stay where they were dropped.
   */
  compactMainTrack(options?: { before?: Project; anchor?: string[] }): void;
  /** Cut a stretch of time out of the timeline: what follows moves back, on every unlocked track or just `trackIds`. */
  removeRange(from: Micros, to: Micros, trackIds?: string[]): void;
  /** Put a track's clips in this order, back to back; clips linked to them follow. `ids` must list all of them. */
  reorderClips(trackId: string, ids: string[]): void;
  addMarker(time: Micros): string;
  updateMarker(id: string, patch: Partial<Omit<Marker, "id">>, options?: { history?: boolean }): void;
  removeMarker(id: string): void;
  /**
   * `base` is the clip as it was when a drag began: its keyframes are re-cut from there on every step, so pulling an
   * edge in and back out within one drag brings back the keyframes it passed over.
   */
  /**
   * Moves one edge of a clip. With `glue.magnet` on a main-track clip, the clip stays glued to its neighbours like
   * in CapCut: dragging either edge outwards brings back what was cut from the media and pushes everything after it
   * (the other tracks and markers too, and with `glue.link` the linked audio grows with it); inwards pulls it back.
   * During a drag `base` is the clip as it was when grabbed (the same object on every call).
   */
  trimSegment(
    id: string,
    edge: "start" | "end",
    time: Micros,
    ripple?: boolean,
    base?: { start: Micros; keyframes: Segment["keyframes"] },
    glue?: { magnet?: boolean; link?: boolean },
  ): void;
  /** Move every keyframe at segment-local `from` (all channels) to `to`; returns where they landed. */
  moveKeyframes(id: string, from: Micros, to: Micros, options?: { history?: boolean }): Micros;
  /** Delete every keyframe at segment-local `local` (all channels). */
  removeKeyframesAt(id: string, local: Micros): void;
  splitAt(time: Micros, id?: string): void;
  deleteSegment(id: string): void;
  updateSegment(id: string, fn: (s: Segment) => void, options?: { history?: boolean }): void;
  /**
   * New speed for a clip: same part of the media, so its length changes. The clips after it on its track move with
   * the end (no gap when it gets faster, no overlap when slower); on the main track with `glue.magnet` the other tracks
   * and markers move too, and with `glue.link` its linked audio gets the same speed.
   */
  setSpeed(id: string, speed: number, glue?: { magnet?: boolean; link?: boolean }, options?: { history?: boolean }): void;
  setAnimated(id: string, prop: ChannelId, value: number, options?: { history?: boolean }): void;
  toggleKeyframe(id: string, prop: ChannelId): void;
  /** Set the curve of every keyframe at segment-local time `local` (all channels). */
  setKeyframeEasing(id: string, local: Micros, easing: Easing): void;
  /** Back to the default value, dropping the property's keyframes. */
  resetAnimated(id: string, props: AnimatableProp[]): void;
  setTransition(id: string, transition: Transition | null): void;
  /** Apply to the selected clip's cut, or else the cut nearest the playhead. Returns false when there is no cut. */
  applyTransition(type: TransitionType): boolean;
  addEffect(id: string, type: EffectType): void;
  updateEffect(id: string, effectId: string, intensity: number, options?: { history?: boolean }): void;
  removeEffect(id: string, effectId: string): void;
  updateTrack(id: string, patch: Partial<Pick<Track, "muted" | "hidden" | "locked" | "name">>): void;

  select(id: string | null): void;
  setPlayhead(t: Micros): void;
  setPlaying(playing: boolean): void;
  setZoom(pxPerSecond: number): void;
}

const clone = <T,>(v: T): T => structuredClone(v);

/** How much time the timeline shows: the project plus room to keep working after its end. */
export const timelineSpan = (project: Project): Micros => Math.max(projectDuration(project) + 20 * SECOND, 60 * SECOND);
/** The closest zoom this project's length allows. */
export const zoomLimit = (project: Project) => Math.min(MAX_ZOOM, MAX_TIMELINE_PX / (timelineSpan(project) / SECOND));

/** Where the extra selected clips go; ui.ts (which imports this store) plugs itself in. */
export const multiSelection = { set: (_ids: string[]) => {} };

/** Copied clips (in-app only; kept outside the project so undo never touches it). */
let clipboard: { base: Micros; items: { trackId: string; kind: TrackKind; segment: Segment }[] } | null = null;

/** The main track: the bottom video track, the one the magnet keeps closed. */
function mainTrack(project: Project): Track | undefined {
  return [...project.tracks].reverse().find((t) => t.kind === "video");
}

/** Overlapping or touching ranges joined, in order. */
function merge(ranges: [Micros, Micros][]): [Micros, Micros][] {
  const out: [Micros, Micros][] = [];
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** The empty stretches between 0 and `end` that `segments` leave. */
function gapsBetween(segments: Segment[], end: Micros): [Micros, Micros][] {
  const gaps: [Micros, Micros][] = [];
  let t = 0;
  for (const [a, b] of merge(segments.map((s) => [s.start, segmentEnd(s)]))) {
    if (a > t) gaps.push([t, a]);
    t = Math.max(t, b);
  }
  if (end > t) gaps.push([t, end]);
  return gaps;
}

/** Where a time lands once `removed` (merged, in order) is cut out of the timeline; a time inside a cut lands on it. */
function cutMapper(removed: [Micros, Micros][]) {
  return (x: Micros) => {
    let shift = 0;
    for (const [a, b] of removed) {
      if (x <= a) break;
      shift += Math.min(x, b) - a;
    }
    return x - shift;
  };
}

/**
 * After stretches of the main track were cut out (`removed`, in the old times), the other tracks close up the same
 * way, so what was placed over the video stays on the same moment. A clip entirely inside a cut goes with it; one
 * across a cut gets shorter by the part that was cut. Markers inside a cut land on it.
 */
function carryAlong(project: Project, main: Track, removed: [Micros, Micros][]) {
  if (!removed.length) return;
  const at = cutMapper(merge(removed));
  for (const track of project.tracks) {
    if (track === main || track.locked) continue;
    const kept: Segment[] = [];
    for (const s of track.segments) {
      const start = at(s.start);
      const duration = at(segmentEnd(s)) - start;
      if (duration < MIN_SEGMENT && duration < s.duration) continue;
      if (duration !== s.duration) {
        s.duration = duration;
        s.fadeIn = Math.min(s.fadeIn, duration);
        s.fadeOut = Math.min(s.fadeOut, duration - s.fadeIn);
        retimeKeyframes(s, 0);
      }
      s.start = start;
      kept.push(s);
    }
    track.segments = kept;
    sortSegments(track);
  }
  for (const m of project.markers) m.time = at(m.time);
  project.markers.sort((a, b) => a.time - b.time);
}

/** A glued trim as it was when the edge was grabbed, so every step of the drag is worked out from the same start. */
interface GlueSnapshot {
  end: Micros;
  /** The clip being trimmed first, then its linked partners. */
  clips: { id: string; start: Micros; sourceStart: Micros; duration: Micros; fadeIn: Micros; fadeOut: Micros; keyframes: Segment["keyframes"] }[];
  /** Everything that starts after the clip, and where it started. */
  followers: Map<string, Micros>;
  /** Per track (not the main one): how far its followers can come back before they touch what stays. */
  room: Map<string, Micros>;
  markers: Map<string, Micros>;
}
const glueSnapshots = new WeakMap<object, GlueSnapshot>();

function glueSnapshot(project: Project, main: Track, s: Segment, key: object, link: boolean): GlueSnapshot {
  const known = glueSnapshots.get(key);
  if (known) return known;
  const end = segmentEnd(s);
  const partners = link && s.linkId
    ? project.tracks.filter((t) => !t.locked).flatMap((t) => t.segments).filter((x) => x !== s && x.linkId === s.linkId && x.start === s.start && x.duration === s.duration)
    : [];
  const clips = [s, ...partners].map((x) => ({ id: x.id, start: x.start, sourceStart: x.sourceStart, duration: x.duration, fadeIn: x.fadeIn, fadeOut: x.fadeOut, keyframes: clone(x.keyframes) }));
  const isClip = (x: Segment) => clips.some((c) => c.id === x.id);
  const followers = new Map<string, Micros>();
  const room = new Map<string, Micros>();
  for (const track of project.tracks) {
    if (track.locked) continue;
    const moving = track.segments.filter((x) => x.start >= end && !isClip(x));
    for (const x of moving) followers.set(x.id, x.start);
    if (track === main || !moving.length) continue;
    const first = Math.min(...moving.map((x) => x.start));
    const staying = track.segments.filter((x) => x.start < end && !isClip(x)).map(segmentEnd);
    room.set(track.id, first - Math.max(Number.NEGATIVE_INFINITY, ...staying));
  }
  const markers = new Map(project.markers.filter((m) => m.time >= end).map((m) => [m.id, m.time] as const));
  const snapshot = { end, clips, followers, room, markers };
  glueSnapshots.set(key, snapshot);
  return snapshot;
}

/**
 * Trims a main-track clip with the magnet on: the clip keeps its place and grows or shrinks by what the edge moved,
 * showing more (or less) of its media, and everything after it on every track moves by the same amount.
 */
function trimGlued(project: Project, main: Track, s: Segment, edge: "start" | "end", t: Micros, key: object, link: boolean) {
  const snap = glueSnapshot(project, main, s, key, link);
  const byId = new Map(project.tracks.flatMap((tr) => tr.segments.map((x) => [x.id, x] as const)));
  const media = (x: Segment) => {
    const m = x.materialId ? project.materials[x.materialId] : undefined;
    return m && m.kind !== "image" ? m : undefined;
  };
  const shortest = -Math.max(0, snap.clips[0].duration - MIN_SEGMENT);
  const most = (fn: (c: GlueSnapshot["clips"][number], x: Segment, m: Material) => number) =>
    Math.min(
      ...snap.clips.map((c) => {
        const x = byId.get(c.id);
        const m = x && media(x);
        return x && m ? fn(c, x, m) : Number.POSITIVE_INFINITY;
      }),
    );
  const grow =
    edge === "start"
      ? Math.min(Math.max(snap.clips[0].start - t, shortest), most((c, x) => Math.floor(c.sourceStart / x.speed)))
      : Math.min(Math.max(t - snap.end, shortest), most((c, x, m) => Math.floor((m.duration - c.sourceStart) / x.speed) - c.duration));
  for (const c of snap.clips) {
    const x = byId.get(c.id);
    if (!x) continue;
    x.start = c.start;
    x.duration = c.duration + grow;
    x.sourceStart = edge === "start" ? Math.max(0, c.sourceStart - Math.round(grow * x.speed)) : c.sourceStart;
    x.fadeIn = Math.min(c.fadeIn, x.duration);
    x.fadeOut = Math.min(c.fadeOut, x.duration - x.fadeIn);
    x.keyframes = clone(c.keyframes);
    retimeKeyframes(x, edge === "start" ? -grow : 0);
  }
  for (const track of project.tracks) {
    const shift = Math.max(grow, -(snap.room.get(track.id) ?? Number.POSITIVE_INFINITY));
    for (const x of track.segments) {
      const from = snap.followers.get(x.id);
      if (from !== undefined) x.start = from + shift;
    }
  }
  for (const m of project.markers) {
    const from = snap.markers.get(m.id);
    if (from !== undefined) m.time = from + grow;
  }
}

function cleanupTracks(project: Project) {
  // Keep at least one video track; drop other empty tracks to avoid clutter.
  project.tracks = project.tracks.filter((t, i, all) => t.segments.length > 0 || t.keep || (t.kind === "video" && all.findIndex((x) => x.kind === "video") === i));
  if (!project.tracks.some((t) => t.kind === "video")) project.tracks.push(createTrack("video", "Principal"));
}

/** Pick (or create) a track of `kind` with room at `start`. Overlays go on top, audio at the bottom. */
function trackWithRoom(project: Project, kind: TrackKind, start: Micros, duration: Micros, preferredId?: string): Track {
  const preferred = project.tracks.find((t) => t.id === preferredId && t.kind === kind && !t.locked);
  if (preferred && isFree(preferred, start, duration)) return preferred;
  const ordered = kind === "video" ? [...project.tracks].reverse() : project.tracks;
  // Caption tracks belong to automatic captions; manual text gets its own track.
  const free = ordered.find((t) => t.kind === kind && !t.locked && !t.role && isFree(t, start, duration));
  if (free) return free;
  const track = createTrack(kind);
  if (kind === "audio") project.tracks.push(track);
  else project.tracks.unshift(track);
  return track;
}

export const useEditor = create<EditorState>((set, get) => ({
  project: createProject(),
  projectPath: null,
  dirty: false,
  previews: {},
  selectedId: null,
  playhead: 0,
  playing: false,
  pxPerSecond: 80,
  past: [],
  future: [],
  status: null,

  checkpoint() {
    const { project, past } = get();
    set({ past: [...past.slice(-HISTORY_LIMIT + 1), clone(project)], future: [], dirty: true });
  },

  mutate(fn, { history = true } = {}) {
    if (history) get().checkpoint();
    const next = clone(get().project);
    fn(next);
    set({ project: next, dirty: true });
  },

  undo() {
    const { past, future, project } = get();
    const prev = past[past.length - 1];
    if (!prev) return;
    set({ project: prev, past: past.slice(0, -1), future: [clone(project), ...future], dirty: true });
    const sel = get().selectedId;
    if (sel && !findSegment(prev, sel)) set({ selectedId: null });
  },

  redo() {
    const { past, future, project } = get();
    const next = future[0];
    if (!next) return;
    set({ project: next, future: future.slice(1), past: [...past, clone(project)], dirty: true });
  },

  newProject() {
    set({ project: createProject(), projectPath: null, dirty: false, past: [], future: [], selectedId: null, playhead: 0, playing: false });
  },

  loadProject(loaded, path) {
    const project = normalizeProject(loaded);
    set({ project, projectPath: path, dirty: false, past: [], future: [], selectedId: null, playhead: 0, playing: false });
    for (const m of Object.values(project.materials)) {
      void loadPreview(m);
      // Saved before its tracks were ready: finish the job (cached files make it quick).
      if (needsSeparation(project, m)) void separateTracks(m.id);
    }
    // Google Fonts used by the project load in the background; text redraws once they arrive.
    void ensureProjectFonts(project).then(() => set({ project: { ...get().project } }));
  },

  markSaved(path) {
    set({ projectPath: path, dirty: false });
  },

  setStatus(text) {
    set({ status: text });
  },

  async importFiles(paths) {
    const added: Material[] = [];
    for (const path of paths) {
      try {
        get().setStatus(`Analisando ${path.split(/[\\/]/).pop()}…`);
        const info = await window.api.probe(path);
        const material: Material = { id: uid("mat"), ...info };
        added.push(material);
        get().mutate((p) => {
          p.materials[material.id] = material;
          // OBS recordings: the extra audio tracks are on the timeline at once, silent until their files are copied out.
          if (material.kind === "video" && (material.audioTracks ?? 0) > 1) {
            const base = material.name.replace(/\.[^.]+$/, "");
            const ids: string[] = [];
            for (let n = 2; n <= (material.audioTracks ?? 0); n++) {
              const id = uid("mat");
              ids.push(id);
              p.materials[id] = { id, kind: "audio", name: `${base} (faixa ${n} de áudio)`, path: "", duration: material.duration, hasVideo: false, hasAudio: false, pending: true };
            }
            p.materials[material.id].audioCompanions = ids;
            material.audioCompanions = ids;
          }
          // Adopt the first video's resolution and frame rate, like CapCut's "original" canvas.
          const isFirstVisual = !Object.values(p.materials).some((m) => m.id !== material.id && m.hasVideo);
          if (isFirstVisual && material.hasVideo && material.width && material.height) {
            p.width = material.width % 2 ? material.width + 1 : material.width;
            p.height = material.height % 2 ? material.height + 1 : material.height;
            if (material.fps && material.fps >= 23 && material.fps <= 61) p.fps = Math.round(material.fps);
          }
        });
        void loadPreview(material);
        // OBS recordings (game, microphone, chat on separate tracks): the extra tracks follow in the background.
        if (needsSeparation(get().project, material)) void separateTracks(material.id);
      } catch (err) {
        get().setStatus(`Falha ao importar: ${(err as Error).message}`);
      }
    }
    if (added.length) get().setStatus(null);
    return added;
  },

  addMaterialToTimeline(materialId, at = {}) {
    const { project, playhead } = get();
    const material = project.materials[materialId];
    if (!material) return null;
    const kind = trackKindFor(material);
    let newId: string | null = null;
    get().mutate((p) => {
      const segment = segmentForMaterial(material, 0);
      if (at.sourceStart !== undefined) segment.sourceStart = at.sourceStart;
      const available = material.kind === "image" ? Number.POSITIVE_INFINITY : material.duration - segment.sourceStart;
      segment.duration = Math.min(at.duration ?? material.duration, available);
      const desired = quantize(at.start ?? (at.trackId ? 0 : playhead), p.fps);
      const place = (): Track => {
        let track = p.tracks.find((t) => t.id === at.trackId && t.kind === kind && !t.locked);
        if (!track && at.newTrack) {
          // The first clip of a project starts the main track; after that each new media gets a track of its own.
          const main = [...p.tracks].reverse().find((t) => t.kind === "video");
          if (kind === "video" && main && !main.locked && !main.segments.length) {
            segment.start = at.start === undefined ? 0 : desired;
            return main;
          }
          const fresh = createTrack(kind);
          if (kind === "audio") p.tracks.push(fresh);
          else p.tracks.unshift(fresh);
          segment.start = desired;
          return fresh;
        }
        if (!track && at.overlay && kind === "video") {
          segment.start = desired;
          const main = [...p.tracks].reverse().find((t) => t.kind === "video");
          // Tracks are drawn top first; any free video track above the main one will do.
          const above = p.tracks.filter((t) => t.kind === "video" && t !== main && !t.locked && !t.role && isFree(t, desired, segment.duration));
          const target = above[0] ?? createTrack("video");
          if (!above.length) p.tracks.unshift(target);
          return target;
        }
        // Dropping on the main track without an explicit time appends, CapCut-style.
        if (!track && at.start === undefined) {
          const main = [...p.tracks].reverse().find((t) => t.kind === kind && !t.locked);
          if (main && kind === "video") {
            segment.start = Math.max(0, ...main.segments.map(segmentEnd));
            return main;
          }
        }
        if (track) segment.start = nearestFreeStart(track, desired, segment.duration);
        else {
          track = trackWithRoom(p, kind, desired, segment.duration);
          segment.start = desired;
        }
        return track;
      };
      const track = place();
      track.segments.push(segment);
      sortSegments(track);
      newId = segment.id;
      // A recording's other audio tracks (OBS microphone, game…) come along, linked to the video.
      linkCompanions(p, segment, (material.audioCompanions ?? []).map((id) => p.materials[id]).filter(Boolean));
    });
    set({ selectedId: newId });
    return newId;
  },

  addOverlay(content, start) {
    const [id] = get().insertOverlays([{ ...content, start: start ?? get().playhead, duration: content.duration ?? 3 * SECOND }]);
    return id;
  },

  insertOverlays(items) {
    const ids: string[] = [];
    get().mutate((p) => {
      for (const item of items) {
        const at = quantize(item.start, p.fps);
        const duration = Math.max(SECOND / p.fps, quantize(item.duration, p.fps));
        const track = trackWithRoom(p, "text", at, duration);
        const segment = createSegment({ ...clone(item), id: uid("seg"), start: at, duration });
        track.segments.push(segment);
        sortSegments(track);
        ids.push(segment.id);
      }
    });
    if (ids.length) set({ selectedId: ids[0] });
    return ids;
  },

  addCaptions(lines, replace) {
    let count = 0;
    get().mutate((p) => {
      if (replace) p.tracks = p.tracks.filter((t) => t.role !== "captions");
      const track: Track = { ...createTrack("text", "Legendas"), role: "captions" };
      const frame = SECOND / p.fps;
      for (const line of lines) {
        const start = quantize(Math.round(line.start * SECOND), p.fps);
        const end = quantize(Math.round(line.end * SECOND), p.fps);
        if (end - start < frame || !isFree(track, start, end - start)) continue;
        track.segments.push(
          createSegment({
            start,
            duration: end - start,
            text: { ...DEFAULT_TEXT, content: line.text, fontSize: 64, strokeWidth: 5 },
            transform: { ...DEFAULT_TRANSFORM, y: 0.72 },
          }),
        );
        count++;
      }
      if (count) p.tracks.unshift(track);
      cleanupTracks(p);
    });
    return count;
  },

  replaceMaterial(segmentId, material, sourceStart) {
    get().mutate((p) => {
      const found = findSegment(p, segmentId);
      if (!found) return;
      p.materials[material.id] = material;
      found.segment.materialId = material.id;
      found.segment.sourceStart = sourceStart;
    });
    void loadPreview(material);
  },

  restoreOriginal(segmentId) {
    get().mutate((p) => {
      const found = findSegment(p, segmentId);
      const current = found?.segment.materialId ? p.materials[found.segment.materialId] : undefined;
      if (!found || !current?.derived || !p.materials[current.derived.from]) return;
      found.segment.materialId = current.derived.from;
      found.segment.sourceStart += current.derived.sourceStart;
    });
  },

  removeMaterials(ids) {
    const gone = new Set(ids.filter((id) => get().project.materials[id]));
    if (!gone.size) return 0;
    let clips = 0;
    get().mutate((p) => {
      for (const id of gone) delete p.materials[id];
      for (const t of p.tracks) {
        const kept = t.segments.filter((s) => !s.materialId || !gone.has(s.materialId));
        clips += t.segments.length - kept.length;
        t.segments = kept;
      }
      cleanupTracks(p);
    });
    const { selectedId, project } = get();
    if (selectedId && !findSegment(project, selectedId)) set({ selectedId: null });
    return clips;
  },

  addText(start) {
    const id = uid("seg");
    get().mutate((p) => {
      const at = quantize(start ?? get().playhead, p.fps);
      const duration = 3 * SECOND;
      const track = trackWithRoom(p, "text", at, duration);
      track.segments.push(createSegment({ id, start: at, duration, text: { ...DEFAULT_TEXT } }));
      sortSegments(track);
    });
    set({ selectedId: id });
    return id;
  },

  moveSegment(id, start, trackId) {
    get().mutate(
      (p) => {
        const found = findSegment(p, id);
        if (!found || found.track.locked) return;
        const target = p.tracks.find((t) => t.id === trackId);
        const segment = found.segment;
        const dest = target && target.kind === found.track.kind && !target.locked ? target : found.track;
        const startAt = Math.max(0, quantize(start, p.fps));
        if (!isFree(dest, startAt, segment.duration, id)) return;
        segment.start = startAt;
        if (dest !== found.track) {
          found.track.segments.splice(found.index, 1);
          dest.segments.push(segment);
        }
        sortSegments(dest);
      },
      { history: false },
    );
  },

  addTrack(kind) {
    const track: Track = { ...createTrack(kind), keep: true };
    get().mutate((p) => {
      if (kind === "audio") p.tracks.push(track);
      else p.tracks.unshift(track);
    });
    return track.id;
  },

  moveClip(id, start, target, others, options = {}) {
    let landed: string | null = null;
    get().mutate(
      (p) => {
        const found = findSegment(p, id);
        if (!found || found.track.locked) return;
        const segment = found.segment;
        const startAt = Math.max(0, quantize(start, p.fps));
        // The clips that go along (its linked audio, its group) only move in time and keep their tracks.
        const along = others.map((x) => findSegment(p, x)).filter((f): f is NonNullable<typeof f> => Boolean(f && f.segment.id !== id && !f.track.locked));
        const d = Math.max(startAt - segment.start, -Math.min(segment.start, ...along.map((f) => f.segment.start)));
        const ignore = new Set([id, ...along.map((f) => f.segment.id)]);
        const fits = along.every((f) => f.track.segments.every((s) => ignore.has(s.id) || !overlaps(s, { start: f.segment.start + d, duration: f.segment.duration })));
        if (!fits) return;
        let dest: Track | undefined;
        if (target === "new") {
          // A new track of the clip's kind: video and text go on top of everything, audio at the bottom.
          dest = createTrack(found.track.kind);
          if (found.track.kind === "audio") p.tracks.push(dest);
          else p.tracks.unshift(dest);
        } else {
          const t = p.tracks.find((x) => x.id === target);
          dest = t && t.kind === found.track.kind && !t.locked ? t : found.track;
        }
        if (!dest.segments.every((s) => ignore.has(s.id) || !overlaps(s, { start: segment.start + d, duration: segment.duration }))) {
          if (dest === found.track) return;
          // Dropped over another clip: a new track right above it (it takes that row, so the pointer stays on it), the two are stacked.
          if (options.stack && target !== "new") {
            const fresh = createTrack(found.track.kind);
            const at = p.tracks.indexOf(dest);
            p.tracks.splice(at, 0, fresh);
            dest = fresh;
          }
        }
        if (!dest.segments.every((s) => ignore.has(s.id) || !overlaps(s, { start: segment.start + d, duration: segment.duration }))) {
          if (dest === found.track) return;
          // No room on that track at this time: it stays where it was and moves in time only.
          if (!found.track.segments.every((s) => ignore.has(s.id) || !overlaps(s, { start: segment.start + d, duration: segment.duration }))) return;
          if (target === "new") p.tracks = p.tracks.filter((t) => t !== dest);
          dest = found.track;
        }
        for (const f of along) f.segment.start += d;
        segment.start += d;
        if (dest !== found.track) {
          found.track.segments.splice(found.track.segments.indexOf(segment), 1);
          dest.segments.push(segment);
        }
        for (const t of p.tracks) sortSegments(t);
        landed = dest.id;
      },
      { history: false },
    );
    return landed;
  },

  dropEmptyTracks() {
    const { project } = get();
    const main = mainTrack(project);
    if (!project.tracks.some((t) => !t.segments.length && t !== main && !t.keep)) return;
    get().mutate((p) => {
      const keep = mainTrack(p);
      p.tracks = p.tracks.filter((t) => t.segments.length || t === keep || t.keep);
    }, { history: false });
  },

  moveTrack(trackId, index) {
    const from = get().project.tracks.findIndex((t) => t.id === trackId);
    if (from < 0) return;
    get().mutate((p) => {
      const mainBefore = [...p.tracks].reverse().find((t) => t.kind === "video");
      const [track] = p.tracks.splice(from, 1);
      // Picture tracks (video, text) above, sound below: a video under the audio would not be seen in the stack.
      const firstAudio = p.tracks.findIndex((t) => t.kind === "audio");
      const lo = track.kind === "audio" ? (firstAudio < 0 ? p.tracks.length : firstAudio) : 0;
      const hi = track.kind === "audio" ? p.tracks.length : firstAudio < 0 ? p.tracks.length : firstAudio;
      p.tracks.splice(Math.max(lo, Math.min(hi, index)), 0, track);
      // The bottom video track is the main one: its name follows it.
      const mainAfter = [...p.tracks].reverse().find((t) => t.kind === "video");
      if (mainBefore && mainAfter && mainBefore !== mainAfter && mainBefore.name === "Principal") {
        mainBefore.name = mainAfter.name === "Principal" ? "Vídeo" : mainAfter.name;
        mainAfter.name = "Principal";
      }
    });
  },

  removeTrack(trackId) {
    get().mutate((p) => {
      const track = p.tracks.find((t) => t.id === trackId);
      if (!track || track.locked) return;
      p.tracks = p.tracks.filter((t) => t !== track);
      cleanupTracks(p);
    });
    const ids = new Set(get().project.tracks.flatMap((t) => t.segments.map((s) => s.id)));
    if (get().selectedId && !ids.has(get().selectedId!)) set({ selectedId: null });
  },

  moveSegments(ids, delta) {
    get().mutate(
      (p) => {
        const moving = ids.map((id) => findSegment(p, id)).filter((f): f is NonNullable<typeof f> => Boolean(f && !f.track.locked));
        if (!moving.length) return;
        const d = Math.max(quantize(delta, p.fps), -Math.min(...moving.map((f) => f.segment.start)));
        const movingIds = new Set(moving.map((f) => f.segment.id));
        // Every clip must land on free space, ignoring the other clips that move with it.
        const fits = moving.every((f) => f.track.segments.every((s) => movingIds.has(s.id) || !overlaps(s, { start: f.segment.start + d, duration: f.segment.duration })));
        if (!fits) return;
        for (const f of moving) f.segment.start += d;
        for (const t of p.tracks) sortSegments(t);
      },
      { history: false },
    );
  },

  deleteSegments(ids, ripple, magnet = false) {
    get().mutate((p) => {
      const main = mainTrack(p);
      const before = main ? main.segments.map((s) => segmentEnd(s)) : [];
      const fromMain: [Micros, Micros][] = [];
      for (const id of ids) {
        const found = findSegment(p, id);
        if (!found || found.track.locked) continue;
        const removed = found.segment;
        found.track.segments.splice(found.index, 1);
        if (found.track === main) {
          fromMain.push([removed.start, segmentEnd(removed)]);
          continue;
        }
        // Ripple: close the gap by pulling later clips on the same track back.
        if (ripple) for (const s of found.track.segments) if (s.start >= segmentEnd(removed)) s.start -= removed.duration;
      }
      if (main && fromMain.length && (ripple || magnet)) {
        // With the magnet every gap of the main track closes; a ripple delete closes only what was deleted.
        const removed = magnet ? gapsBetween(main.segments, Math.max(...before)) : merge(fromMain);
        const at = cutMapper(removed);
        for (const s of main.segments) s.start = at(s.start);
        carryAlong(p, main, removed);
      }
      cleanupTracks(p);
    });
    const { selectedId } = get();
    if (selectedId && ids.includes(selectedId)) set({ selectedId: null });
  },

  copySegments(ids) {
    const { project } = get();
    const items = ids.map((id) => findSegment(project, id)).filter((f): f is NonNullable<typeof f> => Boolean(f));
    if (!items.length) return 0;
    clipboard = {
      base: Math.min(...items.map((f) => f.segment.start)),
      items: items.map((f) => ({ trackId: f.track.id, kind: f.track.kind, segment: clone(f.segment) })),
    };
    return items.length;
  },

  pasteSegments(at) {
    const board = clipboard;
    if (!board) return [];
    const pasted: string[] = [];
    // Pasted copies form their own groups, apart from the originals.
    const groups = new Map<string, string>();
    get().mutate((p) => {
      const offset = quantize(at, p.fps) - board.base;
      for (const item of board.items) {
        const segment: Segment = { ...clone(item.segment), id: uid("seg"), start: item.segment.start + offset };
        if (segment.groupId) {
          if (!groups.has(segment.groupId)) groups.set(segment.groupId, uid("grp"));
          segment.groupId = groups.get(segment.groupId);
        }
        if (segment.materialId && !p.materials[segment.materialId]) continue;
        const original = p.tracks.find((t) => t.id === item.trackId && !t.locked);
        const track = original && isFree(original, segment.start, segment.duration) ? original : trackWithRoom(p, item.kind, segment.start, segment.duration);
        track.segments.push(segment);
        sortSegments(track);
        pasted.push(segment.id);
      }
    });
    if (pasted.length) get().selectMany(pasted);
    return pasted;
  },

  groupSegments(ids) {
    const unique = [...new Set(ids)].filter((id) => findSegment(get().project, id));
    if (unique.length < 2) return null;
    const groupId = uid("grp");
    get().mutate((p) => {
      // Clips already in a group bring the rest of it along.
      const old = new Set(p.tracks.flatMap((t) => t.segments).filter((s) => unique.includes(s.id) && s.groupId).map((s) => s.groupId));
      for (const t of p.tracks) for (const s of t.segments) if (unique.includes(s.id) || (s.groupId && old.has(s.groupId))) s.groupId = groupId;
    });
    return groupId;
  },

  ungroupSegments(ids) {
    const all = get().project.tracks.flatMap((t) => t.segments);
    const groups = new Set(all.filter((s) => ids.includes(s.id) && s.groupId).map((s) => s.groupId));
    if (!groups.size) return 0;
    let count = 0;
    get().mutate((p) => {
      for (const t of p.tracks)
        for (const s of t.segments)
          if (s.groupId && groups.has(s.groupId)) {
            s.groupId = null;
            count++;
          }
    });
    return count;
  },

  selectMany(ids) {
    const unique = [...new Set(ids)];
    set({ selectedId: unique[0] ?? null });
    // The extra selection lives in the view state (ui.ts), which subscribes to this store.
    multiSelection.set(unique.slice(1));
  },

  pasteAttributes(ids) {
    const source = clipboard?.items[0]?.segment;
    if (!source) return 0;
    let count = 0;
    get().mutate((p) => {
      for (const id of ids) {
        const found = findSegment(p, id);
        if (!found || found.track.locked || found.segment.id === source.id) continue;
        const s = found.segment;
        // Animation, look and layering; timing and content stay the target's own.
        s.transform = clone(source.transform);
        s.keyframes = clone(source.keyframes);
        s.blend = source.blend;
        if (s.materialId && source.materialId) {
          s.effects = clone(source.effects);
          s.adjust = clone(source.adjust);
          s.crop = clone(source.crop);
          s.mask = clone(source.mask);
        }
        if (s.text && source.text) s.text = { ...clone(source.text), content: s.text.content };
        retimeKeyframes(s, 0);
        count++;
      }
    });
    return count;
  },

  detachAudio(id) {
    const { project } = get();
    const found = findSegment(project, id);
    const material = found?.segment.materialId ? project.materials[found.segment.materialId] : undefined;
    if (!found || found.track.kind !== "video" || !material?.hasAudio || found.segment.volume <= 0) return null;
    const newId = uid("seg");
    get().mutate((p) => {
      const f = findSegment(p, id)!;
      const s = f.segment;
      const track = trackWithRoom(p, "audio", s.start, s.duration);
      track.segments.push(
        createSegment({
          id: newId,
          materialId: s.materialId,
          start: s.start,
          duration: s.duration,
          sourceStart: s.sourceStart,
          speed: s.speed,
          volume: s.volume,
          fadeIn: s.fadeIn,
          fadeOut: s.fadeOut,
          keepPitch: s.keepPitch,
          linkId: s.linkId ?? (s.linkId = uid("lnk")),
        }),
      );
      sortSegments(track);
      // The video keeps playing silently; its sound now lives on the audio track.
      s.volume = 0;
    });
    set({ selectedId: newId });
    return newId;
  },

  deleteToPlayhead(id, side, magnet = false) {
    const { project, playhead } = get();
    const found = findSegment(project, id);
    if (!found || playhead <= found.segment.start || playhead >= segmentEnd(found.segment)) return false;
    get().checkpoint();
    const t = quantize(playhead, project.fps);
    const removed: [Micros, Micros] = side === "left" ? [found.segment.start, t] : [t, segmentEnd(found.segment)];
    get().trimSegment(id, side === "left" ? "start" : "end", playhead);
    // The magnet closes the main track right after; the other tracks close up the same way.
    if (magnet && found.track === mainTrack(project)) get().mutate((p) => carryAlong(p, mainTrack(p)!, [removed]), { history: false });
    return true;
  },

  insertFreezeFrame(id, material, duration) {
    const { playhead } = get();
    let newId: string | null = null;
    get().mutate((p) => {
      const found = findSegment(p, id);
      if (!found || found.track.locked) return;
      const s = found.segment;
      const t = quantize(playhead, p.fps);
      if (t <= s.start || t >= segmentEnd(s)) return;
      p.materials[material.id] = material;
      // Split, push everything after the cut right, and put the still frame in the gap.
      const right: Segment = { ...clone(s), id: uid("seg"), start: t + duration, duration: segmentEnd(s) - t, sourceStart: s.sourceStart + Math.round((t - s.start) * s.speed), fadeIn: 0, transition: s.transition };
      for (const other of found.track.segments) if (other.start >= segmentEnd(s)) other.start += duration;
      s.duration = t - s.start;
      s.fadeOut = 0;
      s.transition = null;
      retimeKeyframes(s, 0);
      retimeKeyframes(right, t - s.start);
      const still = createSegment({ start: t, duration, materialId: material.id, transform: clone(s.transform), crop: clone(s.crop), adjust: clone(s.adjust), filter: clone(s.filter), flipX: s.flipX, flipY: s.flipY, volume: 0 });
      newId = still.id;
      found.track.segments.push(still, right);
      sortSegments(found.track);
    });
    void loadPreview(material);
    if (newId) set({ selectedId: newId });
    return newId;
  },

  flip(ids, axis) {
    get().mutate((p) => {
      for (const id of ids) {
        const f = findSegment(p, id);
        if (!f || f.track.locked) continue;
        if (axis === "x") f.segment.flipX = !f.segment.flipX;
        else f.segment.flipY = !f.segment.flipY;
      }
    });
  },

  rotate90(ids) {
    get().mutate((p) => {
      for (const id of ids) {
        const f = findSegment(p, id);
        if (!f || f.track.locked) continue;
        const r = f.segment.transform.rotation + 90;
        f.segment.transform.rotation = r > 180 ? r - 360 : r;
        delete f.segment.keyframes.rotation;
      }
    });
  },

  compactMainTrack(options) {
    // Gap in front of each clip before the edit (by clip id).
    const kept = new Map<string, Micros>();
    const was = options?.before ? mainTrack(options.before) : undefined;
    if (was) {
      let end = 0;
      for (const s of [...was.segments].sort((a, b) => a.start - b.start)) {
        if (s.start - end > 1000) kept.set(s.id, s.start - end);
        end = Math.max(end, segmentEnd(s));
      }
    }
    const anchor = new Set(options?.anchor ?? []);
    get().mutate(
      (p) => {
        // The main track is the bottom video track; the magnet keeps its clips back to back from 0.
        const main = [...p.tracks].reverse().find((t) => t.kind === "video");
        if (!main || main.locked) return;
        sortSegments(main);
        let t = 0;
        for (const s of main.segments) {
          const target = anchor.has(s.id) ? Math.max(t, s.start) : t + (kept.get(s.id) ?? 0);
          const shift = target - s.start;
          if (shift !== 0) {
            s.start = target;
            // Linked clips (detached audio) follow their video.
            if (s.linkId) for (const tr of p.tracks) for (const x of tr.segments) if (x !== s && x.linkId === s.linkId) x.start += shift;
          }
          t = segmentEnd(s);
        }
      },
      { history: false },
    );
  },

  removeRange(from, to, trackIds) {
    get().mutate((p) => {
      const a = quantize(from, p.fps);
      const b = quantize(to, p.fps);
      const gap = b - a;
      if (gap <= 0) return;
      const frame = SECOND / p.fps;
      // Both halves of a linked pair are cut at the same points, so right halves pair up under a new link.
      const newLinks = new Map<string, string>();
      for (const track of p.tracks) {
        if (track.locked || (trackIds && !trackIds.includes(track.id))) continue;
        const kept: Segment[] = [];
        for (const s of track.segments) {
          const end = segmentEnd(s);
          if (end <= a) kept.push(s);
          else if (s.start >= b) {
            s.start -= gap;
            kept.push(s);
          } else {
            const keepLeft = a - s.start >= frame;
            if (end - b >= frame) {
              const cut = b - s.start;
              const right: Segment = { ...clone(s), id: keepLeft ? uid("seg") : s.id, start: a, duration: end - b, sourceStart: s.sourceStart + Math.round(cut * s.speed), fadeIn: 0 };
              if (keepLeft && s.linkId) {
                right.linkId = newLinks.get(s.linkId) ?? uid("lnk");
                newLinks.set(s.linkId, right.linkId);
              }
              retimeKeyframes(right, cut);
              kept.push(right);
            }
            if (keepLeft) {
              s.duration = a - s.start;
              s.fadeOut = 0;
              s.transition = null;
              retimeKeyframes(s, 0);
              kept.push(s);
            }
          }
        }
        track.segments = kept;
        sortSegments(track);
      }
      if (!trackIds) {
        p.markers = p.markers.filter((m) => m.time < a || m.time >= b);
        for (const m of p.markers) if (m.time >= b) m.time -= gap;
      }
      cleanupTracks(p);
    });
    const { selectedId, project } = get();
    if (selectedId && !findSegment(project, selectedId)) set({ selectedId: null });
  },

  reorderClips(trackId, ids) {
    get().mutate((p) => {
      const track = p.tracks.find((t) => t.id === trackId);
      if (!track || track.locked) return;
      const others = p.tracks.filter((t) => t !== track).flatMap((t) => t.segments);
      let t = Math.min(...track.segments.map((s) => s.start));
      const moves: { segment: Segment; partners: Segment[]; to: Micros }[] = [];
      for (const id of ids) {
        const segment = track.segments.find((s) => s.id === id)!;
        // A link pair sits at the same place; after splits, several pairs can come from one clip.
        const partners = segment.linkId ? others.filter((x) => x.linkId === segment.linkId && x.start === segment.start && x.duration === segment.duration) : [];
        moves.push({ segment, partners, to: t });
        t += segment.duration;
      }
      for (const { segment, partners, to } of moves) {
        for (const x of partners) x.start = to;
        segment.start = to;
      }
      for (const tr of p.tracks) sortSegments(tr);
    });
  },

  addMarker(time) {
    const id = uid("mk");
    get().mutate((p) => {
      p.markers.push({ id, time: quantize(time, p.fps), label: `Marcador ${p.markers.length + 1}`, color: "#ffd400" });
      p.markers.sort((a, b) => a.time - b.time);
    });
    return id;
  },

  updateMarker(id, patch, options) {
    get().mutate((p) => {
      const m = p.markers.find((x) => x.id === id);
      if (m) Object.assign(m, patch);
      p.markers.sort((a, b) => a.time - b.time);
    }, options);
  },

  removeMarker(id) {
    get().mutate((p) => void (p.markers = p.markers.filter((m) => m.id !== id)));
  },

  trimSegment(id, edge, time, ripple = false, base, glue) {
    get().mutate(
      (p) => {
        const found = findSegment(p, id);
        if (!found || found.track.locked) return;
        const s = found.segment;
        const material = s.materialId ? p.materials[s.materialId] : undefined;
        const t = quantize(time, p.fps);
        const neighbours = found.track.segments.filter((x) => x.id !== id);
        if (glue?.magnet && found.track === mainTrack(p)) {
          trimGlued(p, found.track, s, edge, t, base ?? s, Boolean(glue.link));
          return;
        }
        if (edge === "start") {
          const prevEnd = Math.max(0, ...neighbours.filter((x) => segmentEnd(x) <= s.start).map(segmentEnd));
          // Can't extend before the source's first frame.
          const earliest = material && material.kind !== "image" ? s.start - Math.floor(s.sourceStart / s.speed) : 0;
          const newStart = Math.min(Math.max(t, prevEnd, earliest, 0), segmentEnd(s) - MIN_SEGMENT);
          const delta = newStart - s.start;
          s.sourceStart = Math.max(0, s.sourceStart + Math.round(delta * s.speed));
          s.start = newStart;
          s.duration -= delta;
          if (base) {
            s.keyframes = clone(base.keyframes);
            retimeKeyframes(s, newStart - base.start);
          } else retimeKeyframes(s, delta);
        } else {
          const oldEnd = segmentEnd(s);
          const following = neighbours.filter((x) => x.start >= oldEnd);
          // With ripple the clips after this one move along instead of blocking the trim.
          const nextStart = ripple ? Number.POSITIVE_INFINITY : Math.min(Number.POSITIVE_INFINITY, ...following.map((x) => x.start));
          const limit = s.start + maxDuration(s, material);
          const newEnd = Math.max(Math.min(t, nextStart, limit), s.start + MIN_SEGMENT);
          s.duration = newEnd - s.start;
          if (ripple) for (const x of following) x.start += newEnd - oldEnd;
          if (base) s.keyframes = clone(base.keyframes);
          retimeKeyframes(s, 0);
        }
      },
      { history: false },
    );
  },

  splitAt(time, id) {
    const { project, selectedId } = get();
    const t = quantize(time, project.fps);
    const targets: string[] = [];
    const explicit = id ?? selectedId;
    const candidates = project.tracks.filter((track) => !track.locked).flatMap((track) => track.segments.filter((s) => t > s.start + MIN_SEGMENT / 2 && t < segmentEnd(s) - MIN_SEGMENT / 2));
    for (const s of candidates) if (!explicit || s.id === explicit) targets.push(s.id);
    if (!targets.length) return;
    // Linked clips are cut together, so each piece keeps its own partner.
    const links = new Set(candidates.filter((s) => targets.includes(s.id) && s.linkId).map((s) => s.linkId));
    for (const s of candidates) if (s.linkId && links.has(s.linkId) && !targets.includes(s.id)) targets.push(s.id);
    const newLinks = new Map<string, string>();
    let rightId: string | null = null;
    get().mutate((p) => {
      for (const segId of targets) {
        const found = findSegment(p, segId);
        if (!found) continue;
        const left = found.segment;
        const right: Segment = clone(left);
        right.id = uid("seg");
        const cut = t - left.start;
        right.start = t;
        right.duration = left.duration - cut;
        right.sourceStart = left.sourceStart + Math.round(cut * left.speed);
        right.fadeIn = 0;
        if (left.linkId) {
          right.linkId = newLinks.get(left.linkId) ?? uid("lnk");
          newLinks.set(left.linkId, right.linkId);
        }
        left.duration = cut;
        left.fadeOut = 0;
        left.transition = null; // the outgoing transition now belongs to the right half
        retimeKeyframes(left, 0);
        retimeKeyframes(right, cut);
        found.track.segments.splice(found.index + 1, 0, right);
        if (segId === explicit) rightId = right.id;
      }
    });
    if (rightId) set({ selectedId: rightId });
  },

  deleteSegment(id) {
    get().mutate((p) => {
      const found = findSegment(p, id);
      if (!found || found.track.locked) return;
      found.track.segments.splice(found.index, 1);
      cleanupTracks(p);
    });
    if (get().selectedId === id) set({ selectedId: null });
  },

  updateSegment(id, fn, options) {
    get().mutate((p) => {
      const found = findSegment(p, id);
      if (found) fn(found.segment);
    }, options);
  },

  setSpeed(id, speed, glue, options) {
    get().mutate((p) => {
      const found = findSegment(p, id);
      if (!found || found.track.locked || !(speed > 0)) return;
      const primary = found.segment;
      const targets = [primary, ...(glue?.link && primary.linkId ? p.tracks.flatMap((t) => (t.locked ? [] : t.segments.filter((s) => s !== primary && s.linkId === primary.linkId))) : [])];
      const oldEnd = segmentEnd(primary);
      let delta = 0;
      for (const s of targets) {
        const material = s.materialId ? p.materials[s.materialId] : undefined;
        const source = s.duration * s.speed;
        const before = s.duration;
        s.speed = speed;
        s.duration = Math.max(SECOND / 10, Math.min(Math.round(source / speed), maxDuration(s, material)));
        // Keyframes stay on the same moment of the media.
        const ratio = s.duration / before;
        for (const frames of Object.values(s.keyframes)) for (const k of frames ?? []) k.time = Math.round(k.time * ratio);
        if (s === primary) delta = segmentEnd(s) - oldEnd;
      }
      if (!delta) return;
      const everything = Boolean(glue?.magnet) && found.track === mainTrack(p);
      const tracks = new Set(targets.map((s) => p.tracks.find((t) => t.segments.includes(s))));
      for (const track of p.tracks) {
        if (track.locked || (!everything && !tracks.has(track))) continue;
        for (const s of track.segments) if (!targets.includes(s) && s.start >= oldEnd - 1000) s.start = Math.max(0, s.start + delta);
        sortSegments(track);
      }
      if (everything) for (const m of p.markers) if (m.time >= oldEnd) m.time = Math.max(0, m.time + delta);
    }, options);
  },

  setAnimated(id, prop, value, options) {
    const { playhead } = get();
    get().updateSegment(
      id,
      (s) => {
        const frames = s.keyframes[prop];
        if (!frames?.length) {
          setChannelBase(s, prop, value);
          return;
        }
        const local = Math.min(Math.max(0, playhead - s.start), s.duration);
        const existing = keyframeNear(frames, local, get().project.fps);
        if (existing) existing.value = value;
        else frames.push({ time: local, value });
        frames.sort((a, b) => a.time - b.time);
      },
      options,
    );
  },

  toggleKeyframe(id, prop) {
    const { project, playhead } = get();
    const found = findSegment(project, id);
    if (!found) return;
    const s = found.segment;
    const local = Math.min(Math.max(0, playhead - s.start), s.duration);
    get().updateSegment(id, (seg) => {
      const frames = seg.keyframes[prop] ?? [];
      const existing = keyframeNear(frames, local, project.fps);
      if (existing) {
        const rest = frames.filter((k) => k !== existing);
        if (rest.length) seg.keyframes[prop] = rest;
        else {
          setChannelBase(seg, prop, existing.value);
          delete seg.keyframes[prop];
        }
      } else {
        // New keyframe captures the value currently shown at the playhead.
        const current = valueAt(seg, prop, local);
        seg.keyframes[prop] = [...frames, { time: local, value: current }].sort((a, b) => a.time - b.time);
      }
    });
  },

  moveKeyframes(id, from, to, options) {
    const { project } = get();
    const found = findSegment(project, id);
    if (!found) return from;
    const tolerance = SECOND / project.fps / 2;
    const target = Math.min(Math.max(0, quantize(to, project.fps)), found.segment.duration);
    get().updateSegment(
      id,
      (s) => {
        for (const frames of Object.values(s.keyframes)) {
          if (!frames) continue;
          const moving = frames.filter((k) => Math.abs(k.time - from) <= tolerance);
          if (!moving.length) continue;
          // Landing on another keyframe of the same channel replaces it.
          const rest = frames.filter((k) => !moving.includes(k) && Math.abs(k.time - target) > tolerance);
          for (const k of moving) k.time = target;
          frames.splice(0, frames.length, ...rest, moving[0]);
          frames.sort((a, b) => a.time - b.time);
        }
      },
      options,
    );
    return target;
  },

  removeKeyframesAt(id, local) {
    const { project } = get();
    get().updateSegment(id, (s) => {
      for (const prop of Object.keys(s.keyframes) as ChannelId[]) {
        const frames = s.keyframes[prop] ?? [];
        const hit = keyframeNear(frames, local, project.fps);
        if (!hit) continue;
        const rest = frames.filter((k) => k !== hit);
        if (rest.length) s.keyframes[prop] = rest;
        else {
          setChannelBase(s, prop, hit.value);
          delete s.keyframes[prop];
        }
      }
    });
  },

  resetAnimated(id, props) {
    get().updateSegment(id, (s) => {
      for (const prop of props) {
        s.transform[prop] = DEFAULT_TRANSFORM[prop];
        delete s.keyframes[prop];
      }
    });
  },

  setTransition(id, transition) {
    get().updateSegment(id, (s) => void (s.transition = transition));
  },

  applyTransition(type) {
    const { project, selectedId, playhead } = get();
    let target: string | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (const track of project.tracks) {
      if (track.kind !== "video" || track.locked) continue;
      for (let i = 0; i < track.segments.length; i++) {
        const s = track.segments[i];
        if (!nextAdjacent(track, i)) continue;
        // The selected clip wins; otherwise take the cut closest to the playhead.
        const d = s.id === selectedId ? -1 : Math.abs(segmentEnd(s) - playhead);
        if (d < best) {
          best = d;
          target = s.id;
        }
      }
    }
    if (!target) return false;
    const found = findSegment(project, target)!;
    const duration = found.segment.transition?.duration ?? DEFAULT_TRANSITION;
    get().setTransition(target, { type, duration, ...(type === "shape" ? { shape: { ...DEFAULT_TRANSITION_SHAPE } } : {}) });
    set({ selectedId: target });
    return true;
  },

  addEffect(id, type) {
    get().updateSegment(id, (s) => {
      // One instance per effect type; re-adding just resets it to full strength.
      const existing = s.effects.find((e) => e.type === type);
      if (existing) existing.intensity = DEFAULT_EFFECT_INTENSITY;
      else s.effects.push({ id: uid("fx"), type, intensity: DEFAULT_EFFECT_INTENSITY });
    });
  },

  updateEffect(id, effectId, intensity, options) {
    get().updateSegment(
      id,
      (s) => {
        const e = s.effects.find((x) => x.id === effectId);
        if (e) e.intensity = intensity;
      },
      options,
    );
  },

  removeEffect(id, effectId) {
    get().updateSegment(id, (s) => {
      s.effects = s.effects.filter((e) => e.id !== effectId);
      delete s.keyframes[`fx:${effectId}`];
    });
  },

  setKeyframeEasing(id, local, easing) {
    const fps = get().project.fps;
    get().updateSegment(id, (s) => {
      for (const frames of Object.values(s.keyframes)) {
        const k = keyframeNear(frames, local, fps);
        if (k) k.easing = easing;
      }
    });
  },

  updateTrack(id, patch) {
    get().mutate((p) => {
      const t = p.tracks.find((x) => x.id === id);
      if (t) Object.assign(t, patch);
    });
  },

  select(id) {
    set({ selectedId: id });
  },

  setPlayhead(t) {
    const end = projectDuration(get().project);
    set({ playhead: Math.max(0, Math.min(t, Math.max(end, 0))) });
  },

  setPlaying(playing) {
    set({ playing });
  },

  setZoom(pxPerSecond) {
    set({ pxPerSecond: Math.max(MIN_ZOOM, Math.min(zoomLimit(get().project), pxPerSecond)) });
  },
}));

/** Linked audio clips for a video clip's extra recording tracks, at the same place and source range. */
function linkCompanions(p: Project, segment: Segment, companions: Material[]) {
  if (!companions.length) return;
  segment.linkId ??= uid("lnk");
  for (const audio of companions) {
    const clip = createSegment({
      materialId: audio.id,
      start: segment.start,
      duration: Math.min(segment.duration, Math.round((audio.duration - segment.sourceStart) / segment.speed)),
      sourceStart: segment.sourceStart,
      speed: segment.speed,
      keepPitch: segment.keepPitch,
      linkId: segment.linkId,
    });
    if (clip.duration <= 0) continue;
    const track = trackWithRoom(p, "audio", clip.start, clip.duration);
    track.segments.push(clip);
    sortSegments(track);
  }
}

const needsSeparation = (p: Project, m: Material) =>
  m.kind === "video" && (m.audioTracks ?? 0) > 1 && (!m.audioCompanions || m.audioCompanions.some((id) => p.materials[id]?.pending));
const separating = new Map<string, Promise<void>>();

/** Resolves once a recording's extra audio tracks are on the project (at once when there is nothing to wait for). */
export const whenTracksReady = (materialId: string) => separating.get(materialId) ?? Promise.resolve();

/** Every recording's audio tracks copied out: before an export or a save that leaves the editor. */
export async function whenAllTracksReady() {
  for (const m of Object.values(useEditor.getState().project.materials)) {
    if (needsSeparation(useEditor.getState().project, m)) void separateTracks(m.id);
  }
  await Promise.all([...separating.values()]);
}

/** The real tracks in place of their placeholders (same ids, so the clips stay as they are), in the undo history too. */
function fillPlaceholders(p: Project, materialId: string, extras: Material[]): Project {
  const video = p.materials[materialId];
  if (!video?.audioCompanions) return p;
  const ids = video.audioCompanions;
  const materials = { ...p.materials };
  let changed = false;
  ids.forEach((id, i) => {
    if (!materials[id]?.pending) return;
    const real = extras[i];
    if (real) materials[id] = { ...real, id, name: materials[id].name };
    else delete materials[id];
    changed = true;
  });
  if (!changed) return p;
  const leftover = new Set(ids.filter((id) => !materials[id]));
  const tracks = leftover.size ? p.tracks.map((t) => ({ ...t, segments: t.segments.filter((s) => !s.materialId || !leftover.has(s.materialId)) })) : p.tracks;
  return { ...p, materials: { ...materials, [materialId]: { ...video, audioCompanions: ids.filter((id) => materials[id]) } }, tracks };
}

/**
 * Copy a recording's extra audio tracks out in the background, then add them as materials and link
 * them to every clip of the recording, including clips placed on the timeline in the meantime.
 */
function separateTracks(materialId: string): Promise<void> {
  const running = separating.get(materialId);
  if (running) return running;
  const setFlag = (on: boolean) => useEditor.setState((s) => ({ previews: { ...s.previews, [materialId]: { ...s.previews[materialId], separating: on } } }));
  const job = (async () => {
    const material = useEditor.getState().project.materials[materialId];
    if (!material) return;
    setFlag(true);
    try {
      const files = await window.api.extractAudioTracks(material.path);
      const base = material.name.replace(/\.[^.]+$/, "");
      const extras: Material[] = [];
      for (const [i, file] of files.entries()) extras.push({ id: uid("mat"), ...(await window.api.probe(file)), name: `${base} (faixa ${i + 2} de áudio)` });
      // Another project may be open by now, or the media removed.
      const state = useEditor.getState();
      const current = state.project.materials[materialId];
      if (!current || !needsSeparation(state.project, current)) return;
      if (current.audioCompanions) {
        // Placeholders already on the timeline: filled in place, nothing moves, no undo step.
        const fill = (p: Project) => fillPlaceholders(p, materialId, extras);
        useEditor.setState({ project: fill(state.project), past: state.past.map(fill), future: state.future.map(fill), dirty: true });
        for (const id of useEditor.getState().project.materials[materialId]?.audioCompanions ?? []) {
          const m = useEditor.getState().project.materials[id];
          if (m) void loadPreview(m);
        }
        const text = `${extras.length} faixa(s) de áudio de ${material.name} prontas.`;
        useEditor.getState().setStatus(text);
        setTimeout(() => useEditor.getState().status === text && useEditor.getState().setStatus(null), 4000);
        return;
      }
      if (!extras.length) return;
      useEditor.getState().mutate((p) => {
        for (const extra of extras) p.materials[extra.id] = extra;
        p.materials[materialId].audioCompanions = extras.map((m) => m.id);
        const clips = p.tracks.filter((t) => t.kind === "video").flatMap((t) => t.segments.filter((s) => s.materialId === materialId));
        for (const clip of clips) linkCompanions(p, clip, extras);
      });
      for (const extra of extras) void loadPreview(extra);
      const text = `${extras.length} faixa(s) de áudio de ${material.name} prontas e vinculadas ao vídeo.`;
      useEditor.getState().setStatus(text);
      setTimeout(() => useEditor.getState().status === text && useEditor.getState().setStatus(null), 4000);
    } catch (err) {
      useEditor.getState().setStatus(`Não foi possível separar as faixas de áudio de ${material.name}: ${(err as Error).message}`);
    } finally {
      setFlag(false);
      separating.delete(materialId);
    }
  })();
  separating.set(materialId, job);
  return job;
}

/** One undo step for everything `fn` does (several store actions), or nothing at all if it throws. */
export function oneUndoStep<T>(fn: () => T): T {
  const { project, past, future, dirty } = useEditor.getState();
  try {
    const out = fn();
    if (useEditor.getState().project !== project) useEditor.setState({ past: [...past, project].slice(-HISTORY_LIMIT), future: [], dirty: true });
    return out;
  } catch (err) {
    useEditor.setState({ project, past, future, dirty });
    const { selectedId } = useEditor.getState();
    if (selectedId && !findSegment(project, selectedId)) useEditor.setState({ selectedId: null });
    throw err;
  }
}

const previewRequests = new Set<string>();

/** Fetch thumbnail and waveform for a material in the background. */
async function loadPreview(material: Material) {
  if (material.pending || previewRequests.has(material.id)) return;
  previewRequests.add(material.id);
  const update = (patch: MediaPreview) =>
    useEditor.setState((s) => ({ previews: { ...s.previews, [material.id]: { ...s.previews[material.id], ...patch } } }));
  try {
    if (material.hasVideo || material.kind === "image") {
      const at = material.kind === "image" ? 0 : Math.min(1, material.duration / SECOND / 3);
      update({ thumbnail: await window.api.thumbnail(material.path, at) });
    }
    if (material.hasAudio) update({ waveform: await window.api.waveform(material.path) });
  } catch (err) {
    console.warn(`preview failed for ${material.name}: ${(err as Error).message}`);
  }
}

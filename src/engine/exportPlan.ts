import type { Material, Micros, Project, Segment } from "../model/types";
import { ANIMATABLE } from "../model/types";
import { DEFAULT_ADJUST, isActiveAt, projectDuration, segmentEnd, transitionWindow, valueAt } from "../model/project";
import { SECOND } from "../model/time";
import { framesNeeded, placementAt, visualSize } from "./compositor";

/** Shorter direct stretches are not worth starting an FFmpeg for. */
const MIN_DIRECT_FRAMES = 12;
/** Below this much direct video the plain export is just as good. */
const MIN_TOTAL_DIRECT_SECONDS = 5;

/** Brightness, contrast and saturation of the clip: FFmpeg applies them itself, without the compositor. */
export interface DirectGrade {
  brightness: number;
  contrast: number;
  saturation: number;
}

/** A second video laid over the direct one (a webcam box): cropped, sized and placed, nothing else. */
export interface PipLayer {
  path: string;
  /** Where it starts in its source, in seconds. */
  start: number;
  /** Fractions of the source taken off each side. */
  crop: { left: number; top: number; right: number; bottom: number };
  /** Its box on the canvas, in whole even pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ExportPiece =
  | { kind: "render"; from: number; frames: number }
  | {
      kind: "direct";
      from: number;
      frames: number;
      path: string;
      /** Where it starts in the source, in seconds. */
      start: number;
      /** Bars around the picture, when its shape differs from the canvas. */
      padColor: string | null;
      grade: DirectGrade | null;
      /** Texts, shapes or stickers sit on top: the compositor draws only those, FFmpeg lays them over the video. */
      overlay: boolean;
      /** A second video on top (a webcam box), laid over by FFmpeg too. */
      pip: PipLayer | null;
    };

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const REST = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 } as const;
/** Adjustments FFmpeg cannot reproduce exactly: with any of them the compositor draws the clip. */
const COMPOSITOR_ONLY = ["blur", "temperature", "tint", "sharpen"] as const;

/** From `from` to `to` the clip shows exactly as it is in the file, apart from brightness, contrast and saturation. */
function untouched(s: Segment, from: Micros, to: Micros): boolean {
  const { transform: tr, adjust, crop } = s;
  if (s.speed !== 1 || s.flipX || s.flipY || s.effects.length || s.mask || s.filter || s.blend !== "normal" || s.adjustLayer) return false;
  if (COMPOSITOR_ONLY.some((k) => !near(adjust[k], DEFAULT_ADJUST[k]))) return false;
  if (crop.left || crop.top || crop.right || crop.bottom) return false;
  // Keyframes (a punch-in zoom) only matter while they move the picture: every keyframe is a change point,
  // so a value at rest at both ends and in the middle is at rest all the way.
  const moments = [from, Math.round((from + to) / 2), to].map((t) => t - s.start);
  for (const channel of ANIMATABLE) {
    if (!s.keyframes[channel]?.length) {
      if (!near(tr[channel], REST[channel])) return false;
    } else if (moments.some((local) => !near(valueAt(s, channel, local), REST[channel]))) return false;
  }
  if (Object.entries(s.keyframes).some(([channel, frames]) => channel.startsWith("fx:") && frames?.length)) return false;
  // Fades darken the picture only near the clip's ends.
  return from - s.start >= s.fadeIn && to - s.start <= s.duration - s.fadeOut;
}

/** A clip that never shows: fully transparent, with nothing animating it back. */
const invisible = (s: Segment) => !s.keyframes.opacity?.length && s.transform.opacity <= 0;

/** A video FFmpeg can lay over another as it is: crop, size and place only, the whole stretch. */
function pipLayer(project: Project, s: Segment, material: Material | undefined, from: Micros, to: Micros, start: number): PipLayer | null {
  if (!material?.hasVideo || material.kind === "image" || !material.width || !material.height) return null;
  if (s.speed !== 1 || s.flipX || s.flipY || s.effects.length || s.mask || s.filter || s.adjustLayer || (s.blend && s.blend !== "normal")) return null;
  if ((Object.keys(s.adjust) as (keyof typeof DEFAULT_ADJUST)[]).some((k) => !near(s.adjust[k], DEFAULT_ADJUST[k]))) return null;
  if (Object.values(s.keyframes).some((frames) => frames?.length)) return null;
  if (!near(s.transform.rotation, 0) || s.transform.opacity < 0.999) return null;
  if (from - s.start < s.fadeIn || to - s.start > s.duration - s.fadeOut) return null;
  const { width: W, height: H } = project;
  const sw = Math.max(1, material.width * (1 - s.crop.left - s.crop.right));
  const sh = Math.max(1, material.height * (1 - s.crop.top - s.crop.bottom));
  const fit = Math.min(W / sw, H / sh) * s.transform.scale;
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const width = even(sw * fit);
  const height = even(sh * fit);
  const cx = W / 2 + (s.transform.x * W) / 2;
  const cy = H / 2 + (s.transform.y * H) / 2;
  return { path: material.path, start: Math.max(0, start), crop: { ...s.crop }, x: Math.round(cx - width / 2), y: Math.round(cy - height / 2), width, height };
}

const samePip = (a: PipLayer | null, b: PipLayer | null, fps: number, frames: number) =>
  !a || !b
    ? a === b
    : a.path === b.path && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && near(a.start + frames / fps, b.start) &&
      (["left", "top", "right", "bottom"] as const).every((k) => near(a.crop[k], b.crop[k]));

function gradeOf(s: Segment): DirectGrade | null {
  const { brightness, contrast, saturation } = s.adjust;
  if (near(brightness, DEFAULT_ADJUST.brightness) && near(contrast, DEFAULT_ADJUST.contrast) && near(saturation, DEFAULT_ADJUST.saturation)) return null;
  return { brightness, contrast, saturation };
}

const sameGrade = (a: DirectGrade | null, b: DirectGrade | null) => (!a || !b ? a === b : near(a.brightness, b.brightness) && near(a.contrast, b.contrast) && near(a.saturation, b.saturation));

/** Something FFmpeg can lay over the video from the compositor's drawing: it never looks at what is underneath. */
const simpleOverlay = (s: Segment) => Boolean(s.text || s.shape || s.sticker) && !s.adjustLayer && (!s.blend || s.blend === "normal");

/** The single untouched clip making up the picture from `from` to `to`, or null if the compositor is needed. */
function directClip(project: Project, from: Micros, to: Micros): { segment: Segment; material: Material; padColor: string | null; grade: DirectGrade | null; overlay: boolean; top: Segment | null } | null {
  const t = Math.round((from + to) / 2);
  let found: Segment | null = null;
  let foundAt = -1;
  /** A video above the direct one (a webcam box), FFmpeg lays it over. */
  let top: Segment | null = null;
  let topAt = -1;
  let lowestOverlay = -1;
  for (const [index, track] of project.tracks.entries()) {
    if (track.hidden || track.kind === "audio") continue;
    if (track.kind === "video") {
      const all = framesNeeded(track, t);
      if (all.length > 1) return null;
      // Hidden (opacity 0) the whole time: as if it was not there.
      const active = all.filter((s) => !invisible(s));
      if (active.length === 1) {
        if (top) return null;
        if (found) {
          top = found;
          topAt = foundAt;
        }
        found = active[0];
        foundAt = index;
      }
      continue;
    }
    for (const s of track.segments) {
      if (!isActiveAt(s, t)) continue;
      if (s.adjustLayer || ((s.text || s.shape || s.sticker) && !simpleOverlay(s))) return null;
      if (simpleOverlay(s)) lowestOverlay = index;
    }
  }
  const material = found?.materialId ? project.materials[found.materialId] : undefined;
  if (!found || !material?.hasVideo || material.kind === "image" || !material.width || !material.height) return null;
  // Track 0 is on top: anything drawn has to be above the video (and above the box on it).
  if (lowestOverlay > (top ? topAt : foundAt)) return null;
  if (!untouched(found, from, to)) return null;
  const shared = { segment: found, material, grade: gradeOf(found), overlay: lowestOverlay >= 0, top };
  const sameShape = Math.abs(material.width / material.height - project.width / project.height) < 0.005;
  if (sameShape) return { ...shared, padColor: null };
  if (project.backgroundMode === "blur" || !/^#[0-9a-f]{6}$/i.test(project.background)) return null;
  return { ...shared, padColor: project.background };
}

/** Timeline times where what is on screen can change. */
function changePoints(project: Project): Micros[] {
  const end = projectDuration(project);
  const points = new Set<Micros>([0, end]);
  for (const track of project.tracks) {
    if (track.kind === "audio") continue;
    track.segments.forEach((s, i) => {
      points.add(s.start).add(segmentEnd(s)).add(s.start + s.fadeIn).add(segmentEnd(s) - s.fadeOut);
      const w = transitionWindow(track, i);
      if (w) points.add(w.start).add(w.end);
      if (track.kind !== "video") return;
      for (const channel of ANIMATABLE) for (const frame of s.keyframes[channel] ?? []) points.add(s.start + frame.time);
    });
  }
  return [...points].filter((t) => t >= 0 && t <= end).sort((a, b) => a - b);
}

/** Split the timeline into pieces, or null when exporting it in one go is the better choice. */
export function planExport(project: Project): ExportPiece[] | null {
  const { fps } = project;
  const total = Math.max(1, Math.round((projectDuration(project) / SECOND) * fps));
  /** The first frame drawn at or after `t`. Frame times are whole microseconds, so one can land exactly on a clip's start. */
  const frameAt = (t: Micros) => {
    let frame = Math.ceil((t * fps) / SECOND - 1e-6);
    while (frame > 0 && Math.round(((frame - 1) * SECOND) / fps) >= t) frame--;
    return Math.min(total, frame);
  };
  const points = changePoints(project);
  const pieces: ExportPiece[] = [];
  const addRender = (from: number, frames: number) => {
    const last = pieces.at(-1);
    if (last?.kind === "render") last.frames += frames;
    else pieces.push({ kind: "render", from, frames });
  };
  for (let i = 0; i < points.length - 1; i++) {
    const from = frameAt(points[i]);
    const frames = frameAt(points[i + 1]) - from;
    if (frames <= 0) continue;
    const clip = directClip(project, points[i], points[i + 1]);
    if (!clip) {
      addRender(from, frames);
      continue;
    }
    const last = pieces.at(-1);
    const at = Math.round((from * SECOND) / fps);
    const start = (clip.segment.sourceStart + (at - clip.segment.start)) / SECOND;
    let pip: PipLayer | null = null;
    if (clip.top) {
      pip = pipLayer(project, clip.top, clip.top.materialId ? project.materials[clip.top.materialId] : undefined, points[i], points[i + 1], (clip.top.sourceStart + (at - clip.top.start)) / SECOND);
      if (!pip) {
        addRender(from, frames);
        continue;
      }
    }
    if (last?.kind === "direct" && last.path === clip.material.path && near(last.start + last.frames / fps, start) && last.padColor === clip.padColor && sameGrade(last.grade, clip.grade) && samePip(last.pip, pip, fps, last.frames)) {
      last.frames += frames;
      last.overlay ||= clip.overlay;
    } else pieces.push({ kind: "direct", from, frames, path: clip.material.path, start: Math.max(0, start), padColor: clip.padColor, grade: clip.grade, overlay: clip.overlay, pip });
  }

  // Tiny direct stretches join their neighbors.
  const merged: ExportPiece[] = [];
  for (const piece of pieces) {
    const asRender = piece.kind === "direct" && piece.frames < MIN_DIRECT_FRAMES;
    const last = merged.at(-1);
    if ((asRender || piece.kind === "render") && last?.kind === "render") last.frames += piece.frames;
    else merged.push(asRender ? { kind: "render", from: piece.from, frames: piece.frames } : piece);
  }
  const direct = merged.reduce((sum, p) => sum + (p.kind === "direct" ? p.frames : 0), 0);
  return direct / fps >= MIN_TOTAL_DIRECT_SECONDS ? merged : null;
}

export interface OverlayBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The part of the canvas that texts, shapes and stickers can reach during a piece. Only that rectangle travels
 * to FFmpeg for each frame, which is what makes a captioned hour fast. Null: nothing is drawn in the piece.
 */
export function overlayBox(project: Project, piece: { from: number; frames: number }): OverlayBox | null {
  const { width: W, height: H, fps } = project;
  const from = Math.round((piece.from * SECOND) / fps);
  const to = Math.round(((piece.from + piece.frames) * SECOND) / fps);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const track of project.tracks) {
    if (track.hidden || track.kind === "audio" || track.kind === "video") continue;
    for (const s of track.segments) {
      if (!simpleOverlay(s) || s.start >= to || segmentEnd(s) <= from) continue;
      // Sizes and positions move in straight or eased lines between keyframes: the extremes are at the keyframes.
      const moments = new Set<Micros>([s.start, segmentEnd(s) - 1]);
      for (const channel of ANIMATABLE) for (const frame of s.keyframes[channel] ?? []) moments.add(Math.min(segmentEnd(s) - 1, s.start + frame.time));
      for (const t of moments) {
        const size = visualSize(project, s, t);
        if (!size) continue;
        const place = placementAt(project, s, t);
        const k = (H / 1080) * place.scale;
        // Outlines and glyph overhang go past the measured box.
        const pad = 12 + (s.text ? (s.text.strokeWidth + s.text.fontSize * 0.45) * k : s.shape ? s.shape.strokeWidth * k : 0);
        const turned = Math.abs(place.rotation) > 1e-4;
        const halfW = (turned ? Math.hypot(size.w, size.h) : size.w) / 2 + pad;
        const halfH = (turned ? Math.hypot(size.w, size.h) : size.h) / 2 + pad;
        x0 = Math.min(x0, place.cx - halfW);
        x1 = Math.max(x1, place.cx + halfW);
        y0 = Math.min(y0, place.cy - halfH);
        y1 = Math.max(y1, place.cy + halfH);
      }
    }
  }
  if (x1 <= x0 || y1 <= y0) return null;
  // Whole even pixels: the video's colour planes are half the size.
  const even = (n: number, up: boolean) => (up ? Math.ceil(n / 2) : Math.floor(n / 2)) * 2;
  const x = Math.max(0, even(x0, false));
  const y = Math.max(0, even(y0, false));
  const right = Math.min(even(W, false), even(x1, true));
  const bottom = Math.min(even(H, false), even(y1, true));
  if (right - x < 2 || bottom - y < 2) return null;
  return { x, y, width: right - x, height: bottom - y };
}

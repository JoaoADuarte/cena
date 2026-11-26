/** All times are integer microseconds, matching CapCut's draft format. */
export type Micros = number;

export type MaterialKind = "video" | "audio" | "image";

export interface Material {
  id: string;
  kind: MaterialKind;
  name: string;
  path: string;
  duration: Micros;
  width?: number;
  height?: number;
  fps?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  /** Set on media produced by an AI tool from another material, so the clip can be restored. */
  derived?: { from: string; tool: "removeBackground" | "removeObjects" | "reverse" | "denoise" | "enhance" | "voice"; sourceStart: Micros };
  /**
   * Extra audio tracks of a recording (OBS: microphone, game, Discord…), extracted to their own
   * audio materials. They go on the timeline with the video, linked to it.
   */
  audioCompanions?: string[];
  /**
   * A recording's extra audio track still being copied out: on the timeline at once (it can be moved and cut),
   * silent until the file is ready, then filled in place (same id) with the real file.
   */
  pending?: boolean;
  /** Audio tracks in the file, from the probe (more than one: the extra ones are separated in the background). */
  audioTracks?: number;
  /** Attribution for library audio under a license that asks for credit. */
  credit?: MaterialCredit;
}

export interface MaterialCredit {
  title: string;
  creator: string;
  license: string;
  url: string | null;
  needsCredit: boolean;
}

export type TrackKind = "video" | "audio" | "text";

/** x/y are offsets from canvas center in half-canvas units (-1..1 reaches the edges). */
export interface Transform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
}

export interface Adjust {
  brightness: number;
  contrast: number;
  saturation: number;
  blur: number;
  /** -1 (cool/blue) .. 1 (warm/orange). */
  temperature: number;
  /** -1 (green) .. 1 (magenta). */
  tint: number;
  /** 0..1 sharpening. */
  sharpen: number;
}

export const FILTERS = [
  "vivid",
  "natural",
  "cinema",
  "tealOrange",
  "noir",
  "retro",
  "polaroid",
  "sunset",
  "coldBlue",
  "moody",
  "pastel",
  "neon",
  "golden",
  "faded",
  "punch",
  "forest",
] as const;
export type FilterType = (typeof FILTERS)[number];

/** A color look applied to a clip (one per clip), at 0..1 strength. */
export interface ClipFilter {
  type: FilterType;
  intensity: number;
}

/** Fractions of the source frame cut from each side; the remaining region is what gets fitted to the canvas. */
export interface Crop {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface TextStyle {
  content: string;
  fontFamily: string;
  /** Where the font comes from, so it can be loaded again when the project opens (absent: Windows built-in). */
  fontSource?: "installed" | "custom" | "google";
  fontSize: number;
  color: string;
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right";
  strokeColor: string;
  strokeWidth: number;
  background: string | null;
}

export const ANIMATABLE = ["x", "y", "scale", "rotation", "opacity"] as const;
export type AnimatableProp = (typeof ANIMATABLE)[number];

export const TRANSITIONS = [
  "fade",
  "fadeBlack",
  "fadeWhite",
  "slideLeft",
  "slideRight",
  "slideUp",
  "slideDown",
  "wipeLeft",
  "wipeRight",
  "circle",
  "zoom",
  "blur",
  "wipeUp",
  "wipeDown",
  "wipeDiagonal",
  "diamond",
  "blinds",
  "spin",
  "zoomIn",
  "zoomOut",
  "motionBlur",
  "bounce",
  "glitch",
  "flash",
  "shape",
] as const;
export type TransitionType = (typeof TRANSITIONS)[number];

export const TRANSITION_SHAPES = ["circle", "rectangle", "diamond", "star", "heart", "text"] as const;
export type TransitionShapeKind = (typeof TRANSITION_SHAPES)[number];

/** Settings of the custom "shape" transition: the next clip appears inside a growing shape, or the current one shrinks into it. */
export interface TransitionShape {
  kind: TransitionShapeKind;
  /** Text for kind "text". */
  text: string;
  direction: "grow" | "shrink";
  /** Edge softness as a fraction of the frame's shorter side (0..0.3). */
  softness: number;
  /** Quarter turn while the shape grows. */
  rotate: boolean;
}

/** Outgoing transition into the next clip; only active when that clip starts exactly at this one's end. */
export interface Transition {
  type: TransitionType;
  duration: Micros;
  /** Only for type "shape". */
  shape?: TransitionShape;
}

export const EFFECTS = ["bw", "sepia", "vintage", "warm", "cool", "dramatic", "invert", "hue", "vignette", "glow", "pixelate", "grain", "flash", "shake"] as const;
export type EffectType = (typeof EFFECTS)[number];

export interface Effect {
  id: string;
  type: EffectType;
  /** 0..1 */
  intensity: number;
}

/** Curve from a keyframe to the next: a preset or a CSS-style cubic-bezier (x1, y1, x2, y2). */
export type Easing = "linear" | "easeIn" | "easeOut" | "easeInOut" | "hold" | [number, number, number, number];

/** Keyframe time is relative to the segment's timeline start. */
export interface Keyframe {
  time: Micros;
  value: number;
  /** Shape of the change toward the next keyframe; linear when absent. */
  easing?: Easing;
}

/** An animated value: a transform property, the clip's volume, or `fx:<effect id>` for an effect's intensity. */
export type ChannelId = AnimatableProp | "volume" | `fx:${string}`;

/** Loudest a clip can be turned up (200%). */
export const MAX_VOLUME = 2;

/** Canvas blend modes, in the order editors usually list them. */
export const BLEND_MODES = [
  "normal",
  "darken",
  "multiply",
  "color-burn",
  "lighten",
  "screen",
  "lighter",
  "color-dodge",
  "overlay",
  "soft-light",
  "hard-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
] as const;
export type BlendMode = (typeof BLEND_MODES)[number];

export const MASK_TYPES = ["rectangle", "ellipse", "diamond", "star", "heart", "split", "bars", "text", "freeform"] as const;
export type MaskType = (typeof MASK_TYPES)[number];

/**
 * Mask in the clip's own frame, so it follows the clip's transform. x/y offset the center in
 * half-clip units (-1..1 reaches the edges); width/height are fractions of the clip size.
 */
export interface Mask {
  type: MaskType;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees. */
  rotation: number;
  /** Edge softness as a fraction of the clip's shorter side (0..0.5). */
  feather: number;
  /** Corner rounding for rectangles (0..1). */
  roundness: number;
  invert: boolean;
  /** Text mask content. */
  text: string;
  /** Freeform outline, points in the same half-clip units as x/y. */
  points: [number, number][];
}

export const SHAPE_KINDS = ["rectangle", "ellipse", "triangle", "star", "polygon", "heart", "arrow", "line"] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];

/** A vector shape drawn on an overlay track; size is relative to a 1080-pixel-tall canvas. */
export interface ShapeStyle {
  kind: ShapeKind;
  width: number;
  height: number;
  fill: string | null;
  stroke: string;
  strokeWidth: number;
  /** Corner rounding for rectangles (0..1). */
  roundness: number;
  /** Polygon sides / star points. */
  sides: number;
}

/** Emoji sticker; size is relative to a 1080-pixel-tall canvas. */
export interface Sticker {
  emoji: string;
  size: number;
}

export interface Segment {
  id: string;
  materialId: string | null;
  text: TextStyle | null;
  start: Micros;
  duration: Micros;
  sourceStart: Micros;
  speed: number;
  volume: number;
  fadeIn: Micros;
  fadeOut: Micros;
  transform: Transform;
  adjust: Adjust;
  crop: Crop;
  keyframes: Partial<Record<ChannelId, Keyframe[]>>;
  transition: Transition | null;
  effects: Effect[];
  blend: BlendMode;
  mask: Mask | null;
  /** Overlay-track content besides text. */
  shape: ShapeStyle | null;
  sticker: Sticker | null;
  /** Speed changes keep the voice's pitch (true) or shift it like a tape (false). */
  keepPitch: boolean;
  filter: ClipFilter | null;
  flipX: boolean;
  flipY: boolean;
  /** Clips sharing a link id move and get deleted together (a video and its detached audio). */
  linkId: string | null;
  /** Clips the user grouped (Ctrl+G) get selected, moved and deleted as one. */
  groupId?: string | null;
  /**
   * Adjustment layer (overlay track only): applies its adjustments and filter to everything
   * drawn below it while it is active.
   */
  adjustLayer: boolean;
}

/** Timeline marker. */
export interface Marker {
  id: string;
  time: Micros;
  label: string;
  color: string;
  /** Why the creator marked this point, to come back to it. */
  note?: string;
}

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  muted: boolean;
  hidden: boolean;
  locked: boolean;
  /** Tracks created by automatic captions; regenerating can replace them. */
  role?: "captions";
  /** Made by the creator with "+ Faixa": it stays even while empty, until they delete it. */
  keep?: boolean;
  segments: Segment[];
}

export interface Project {
  version: 1;
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  background: string;
  /** Fill behind the clips: a solid color, or the bottom clip blurred to cover the frame. */
  backgroundMode: "color" | "blur";
  /** Blur radius for backgroundMode "blur", in pixels at 1080p. */
  backgroundBlur: number;
  markers: Marker[];
  materials: Record<string, Material>;
  /** Index 0 is drawn on top and shown first in the timeline. */
  tracks: Track[];
}

/** Derived per-material previews; never stored in the project or undo history. */
export interface MediaPreview {
  /** The recording's extra audio tracks are being copied out. */
  separating?: boolean;
  thumbnail?: string;
  waveform?: { perSecond: number; peaks: number[] };
}

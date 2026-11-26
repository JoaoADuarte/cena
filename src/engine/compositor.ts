import type { BlendMode, Effect, Mask, Material, Micros, Project, Segment, ShapeStyle, Sticker, TextStyle, Track, TransitionShape, TransitionType } from "../model/types";
import { fadeFactor, isActiveAt, transitionWindow, valueAt } from "../model/project";
import { SECOND } from "../model/time";
import type { MediaPool } from "./mediaPool";
import { FILTER_INFO, lookFilter } from "./catalog";

/** Local segment time clamped to the clip, for keyframes and fades during transition overlap. */
const clampedLocal = (s: Segment, t: Micros) => Math.min(Math.max(0, t - s.start), s.duration);

/**
 * Time inside the source media (seconds) shown by a segment at timeline time `t`. Outside the
 * clip (transition overlap) it keeps running into the source handles, clamped to the file.
 */
export function sourceSecondsAt(s: Segment, t: Micros, material?: Material): number {
  const raw = (s.sourceStart + (t - s.start) * s.speed) / SECOND;
  const end = material && material.kind !== "image" ? material.duration / SECOND - 0.001 : Number.POSITIVE_INFINITY;
  return Math.min(Math.max(0, raw), end);
}

export interface Placement {
  opacity: number;
  cx: number;
  cy: number;
  rotation: number;
  scale: number;
}

/** Canvas-space placement of a visual segment at timeline time `t`. */
export function placementAt(project: Project, s: Segment, t: Micros): Placement {
  const local = clampedLocal(s, t);
  return {
    opacity: valueAt(s, "opacity", local) * fadeFactor(s, local),
    cx: project.width / 2 + (valueAt(s, "x", local) * project.width) / 2,
    cy: project.height / 2 + (valueAt(s, "y", local) * project.height) / 2,
    rotation: (valueAt(s, "rotation", local) * Math.PI) / 180,
    scale: valueAt(s, "scale", local),
  };
}

// --- Offscreen layers -------------------------------------------------------------------

const layers: HTMLCanvasElement[] = [];

/** Reusable full-frame scratch canvas `i`, cleared and sized to the project. */
function layer(i: number, w: number, h: number): CanvasRenderingContext2D {
  let c = layers[i];
  if (!c) {
    c = document.createElement("canvas");
    layers[i] = c;
  }
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const ctx = c.getContext("2d", { willReadFrequently: false })!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.filter = "none";
  ctx.imageSmoothingEnabled = true;
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

let noise: HTMLCanvasElement | null = null;

/** Deterministic 256² grayscale noise tile so exports are reproducible. */
function noiseTile(): HTMLCanvasElement {
  if (noise) return noise;
  noise = document.createElement("canvas");
  noise.width = noise.height = 256;
  const ctx = noise.getContext("2d")!;
  const img = ctx.createImageData(256, 256);
  let seed = 0x9e3779b9;
  for (let i = 0; i < img.data.length; i += 4) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const v = (seed >>> 0) & 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return noise;
}

// --- Effects -----------------------------------------------------------------------------

function adjustFilter(s: Pick<Segment, "adjust">, height: number): string[] {
  const a = s.adjust;
  const parts: string[] = [];
  if (a.brightness !== 1) parts.push(`brightness(${a.brightness})`);
  if (a.contrast !== 1) parts.push(`contrast(${a.contrast})`);
  if (a.saturation !== 1) parts.push(`saturate(${a.saturation})`);
  if (a.blur > 0) parts.push(`blur(${(a.blur * height) / 1080}px)`);
  if (a.sharpen > 0) parts.push(`url(#${sharpenFilterId(a.sharpen)})`);
  return parts;
}

/**
 * Canvas has no sharpen filter, but it accepts SVG filters from the document. One
 * feConvolveMatrix per strength step is created on demand.
 */
function sharpenFilterId(amount: number): string {
  const step = Math.max(1, Math.min(10, Math.round(amount * 10)));
  const id = `cena-sharpen-${step}`;
  if (!document.getElementById(id)) {
    const ns = "http://www.w3.org/2000/svg";
    let svg = document.getElementById("cena-filters") as SVGSVGElement | null;
    if (!svg) {
      svg = document.createElementNS(ns, "svg");
      svg.id = "cena-filters";
      svg.setAttribute("style", "position:absolute;width:0;height:0");
      document.body.appendChild(svg);
    }
    const k = (step / 10) * 0.9;
    const filter = document.createElementNS(ns, "filter");
    filter.id = id;
    const conv = document.createElementNS(ns, "feConvolveMatrix");
    conv.setAttribute("order", "3");
    conv.setAttribute("kernelMatrix", `0 ${-k} 0 ${-k} ${1 + 4 * k} ${-k} 0 ${-k} 0`);
    conv.setAttribute("preserveAlpha", "true");
    filter.appendChild(conv);
    svg.appendChild(filter);
  }
  return id;
}

type ColorWash = { color: string; mode: GlobalCompositeOperation; alpha: number };

/** Filter look plus temperature/tint, as CSS filters and color washes. */
function grade(s: Pick<Segment, "adjust" | "filter">, height: number): { css: string[]; washes: ColorWash[] } {
  const css = adjustFilter(s, height);
  const washes: ColorWash[] = [];
  if (s.filter && s.filter.intensity > 0) {
    const look = FILTER_INFO[s.filter.type].look;
    css.push(...lookFilter(look, s.filter.intensity));
    if (look.overlay) washes.push({ ...look.overlay, alpha: look.overlay.alpha * s.filter.intensity });
  }
  const { temperature: temp, tint } = s.adjust;
  if (temp) washes.push({ color: temp > 0 ? "#ff8a00" : "#0a6cff", mode: "soft-light", alpha: Math.abs(temp) * 0.45 });
  if (tint) washes.push({ color: tint > 0 ? "#ff2bd6" : "#1fd65a", mode: "soft-light", alpha: Math.abs(tint) * 0.3 });
  return { css, washes };
}

/** Blend color washes over a layer's own pixels only, keeping its transparency. */
function applyWashes(ctx: CanvasRenderingContext2D, washes: ColorWash[]) {
  if (!washes.length) return;
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const tmp = layer(13, W, H);
  tmp.drawImage(ctx.canvas, 0, 0);
  for (const w of washes) {
    tmp.globalCompositeOperation = w.mode;
    tmp.globalAlpha = w.alpha;
    tmp.fillStyle = w.color;
    tmp.fillRect(0, 0, W, H);
  }
  // Blend modes also paint transparent areas; cut back to the original shape.
  tmp.globalCompositeOperation = "destination-in";
  tmp.globalAlpha = 1;
  tmp.drawImage(ctx.canvas, 0, 0);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(tmp.canvas, 0, 0);
  ctx.restore();
}

/** Adjustment layer: re-grade everything already drawn on the frame. */
function applyAdjustmentLayer(ctx: CanvasRenderingContext2D, s: Segment, opacity: number) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const { css, washes } = grade(s, H);
  if (!css.length && !washes.length) return;
  const graded = layer(14, W, H);
  graded.filter = css.length ? css.join(" ") : "none";
  graded.drawImage(ctx.canvas, 0, 0);
  graded.filter = "none";
  applyWashes(graded, washes);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = Math.min(1, opacity);
  ctx.drawImage(graded.canvas, 0, 0);
  ctx.restore();
}

/** CSS filter functions for the color effects, applied while the frame is drawn. */
function effectFilter(e: Effect): string[] {
  const i = e.intensity;
  switch (e.type) {
    case "bw":
      return [`grayscale(${i})`];
    case "sepia":
      return [`sepia(${i})`];
    case "vintage":
      return [`sepia(${0.6 * i})`, `contrast(${1 + 0.15 * i})`, `saturate(${1 - 0.3 * i})`];
    case "warm":
      return [`sepia(${0.25 * i})`, `saturate(${1 + 0.3 * i})`, `hue-rotate(${-8 * i}deg)`];
    case "cool":
      return [`hue-rotate(${15 * i}deg)`, `saturate(${1 - 0.1 * i})`, `brightness(${1 + 0.03 * i})`];
    case "dramatic":
      return [`contrast(${1 + 0.5 * i})`, `saturate(${1 + 0.2 * i})`, `brightness(${1 - 0.05 * i})`];
    case "invert":
      return [`invert(${i})`];
    case "hue":
      return [`hue-rotate(${Math.round(360 * i)}deg)`];
    default:
      return [];
  }
}

/** Camera shake offset in canvas pixels; smooth pseudo-random motion from summed sines. */
function shakeOffset(effects: Effect[], t: Micros, w: number, h: number): [number, number] {
  const e = effects.find((x) => x.type === "shake");
  if (!e) return [0, 0];
  const s = t / SECOND;
  const amp = e.intensity * 0.02;
  return [
    (Math.sin(s * 23.1) * 0.6 + Math.sin(s * 37.7) * 0.4) * amp * w,
    (Math.sin(s * 29.3 + 1.3) * 0.6 + Math.sin(s * 41.9) * 0.4) * amp * h,
  ];
}

/** Effects that work on the rendered clip pixels (masked to the clip with source-atop). */
function applyPostEffects(ctx: CanvasRenderingContext2D, s: Segment, t: Micros, rect: { cx: number; cy: number; w: number; h: number }) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  for (const e of s.effects) {
    const i = e.intensity;
    if (i <= 0) continue;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    switch (e.type) {
      case "vignette": {
        const r = Math.hypot(rect.w, rect.h) / 2;
        const g = ctx.createRadialGradient(rect.cx, rect.cy, r * (0.75 - 0.45 * i), rect.cx, rect.cy, r);
        g.addColorStop(0, "rgba(0,0,0,0)");
        g.addColorStop(1, `rgba(0,0,0,${0.85 * i})`);
        ctx.globalCompositeOperation = "source-atop";
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
        break;
      }
      case "glow": {
        const scratch = layer(9, W, H);
        scratch.filter = `blur(${(14 * H) / 1080}px) brightness(1.2)`;
        scratch.drawImage(ctx.canvas, 0, 0);
        ctx.globalCompositeOperation = "screen";
        ctx.globalAlpha = 0.85 * i;
        ctx.drawImage(scratch.canvas, 0, 0);
        break;
      }
      case "pixelate": {
        const block = Math.max(2, Math.round((4 + 44 * i) * (H / 1080)));
        const sw = Math.max(1, Math.round(W / block));
        const sh = Math.max(1, Math.round(H / block));
        const small = layer(10, sw, sh);
        small.imageSmoothingEnabled = true;
        small.drawImage(ctx.canvas, 0, 0, sw, sh);
        ctx.clearRect(0, 0, W, H);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(small.canvas, 0, 0, W, H);
        break;
      }
      case "grain": {
        const frame = Math.floor((t / SECOND) * 24);
        const pattern = ctx.createPattern(noiseTile(), "repeat")!;
        pattern.setTransform(new DOMMatrix().translate((frame * 73) % 256, (frame * 151) % 256));
        ctx.globalCompositeOperation = "source-atop";
        ctx.globalAlpha = 0.22 * i;
        ctx.fillStyle = pattern;
        ctx.fillRect(0, 0, W, H);
        break;
      }
      case "flash": {
        // A white pulse twice a second that decays quickly.
        const phase = ((t / SECOND) * 2) % 1;
        const a = Math.max(0, 1 - phase * 4) * i;
        if (a > 0) {
          ctx.globalCompositeOperation = "source-atop";
          ctx.globalAlpha = a;
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, W, H);
        }
        break;
      }
      default:
        break;
    }
    ctx.restore();
  }
}

// --- Shapes and masks ----------------------------------------------------------------------

/** Regular star or polygon outline centered on the origin. */
function starPath(ctx: CanvasRenderingContext2D, w: number, h: number, points: number, inner: number) {
  const steps = inner < 1 ? points * 2 : points;
  for (let i = 0; i < steps; i++) {
    const r = inner < 1 && i % 2 === 1 ? inner : 1;
    const a = -Math.PI / 2 + (i * Math.PI * 2) / steps;
    const x = (Math.cos(a) * r * w) / 2;
    const y = (Math.sin(a) * r * h) / 2;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function heartPath(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const top = -h / 2 + h * 0.28;
  ctx.moveTo(0, h / 2);
  ctx.bezierCurveTo(-w * 0.55, h * 0.1, -w * 0.62, -h / 2, -w * 0.25, -h / 2);
  ctx.bezierCurveTo(-w * 0.08, -h / 2, 0, -h * 0.36, 0, top);
  ctx.bezierCurveTo(0, -h * 0.36, w * 0.08, -h / 2, w * 0.25, -h / 2);
  ctx.bezierCurveTo(w * 0.62, -h / 2, w * 0.55, h * 0.1, 0, h / 2);
  ctx.closePath();
}

/** Outline of a vector shape centered on the origin. */
function shapePath(ctx: CanvasRenderingContext2D, shape: ShapeStyle, w: number, h: number) {
  ctx.beginPath();
  switch (shape.kind) {
    case "rectangle":
      ctx.roundRect(-w / 2, -h / 2, w, h, (shape.roundness * Math.min(w, h)) / 2);
      break;
    case "ellipse":
      ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
      break;
    case "triangle":
      starPath(ctx, w, h, 3, 1);
      break;
    case "star":
      starPath(ctx, w, h, Math.max(3, shape.sides), 0.45);
      break;
    case "polygon":
      starPath(ctx, w, h, Math.max(3, shape.sides), 1);
      break;
    case "heart":
      heartPath(ctx, w, h);
      break;
    case "arrow": {
      const shaft = h * 0.36;
      const head = Math.min(w * 0.45, h);
      ctx.moveTo(-w / 2, -shaft / 2);
      ctx.lineTo(w / 2 - head, -shaft / 2);
      ctx.lineTo(w / 2 - head, -h / 2);
      ctx.lineTo(w / 2, 0);
      ctx.lineTo(w / 2 - head, h / 2);
      ctx.lineTo(w / 2 - head, shaft / 2);
      ctx.lineTo(-w / 2, shaft / 2);
      ctx.closePath();
      break;
    }
    case "line":
      ctx.moveTo(-w / 2, 0);
      ctx.lineTo(w / 2, 0);
      break;
  }
}

/** Draw a shape centered on the origin; sizes are defined for a 1080-pixel-tall canvas. */
function drawShape(ctx: CanvasRenderingContext2D, shape: ShapeStyle, scale: number, canvasHeight: number) {
  const k = (canvasHeight / 1080) * scale;
  shapePath(ctx, shape, shape.width * k, shape.height * k);
  if (shape.fill && shape.kind !== "line") {
    ctx.fillStyle = shape.fill;
    ctx.fill();
  }
  const stroke = shape.kind === "line" ? Math.max(1, shape.strokeWidth) : shape.strokeWidth;
  if (stroke > 0) {
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.lineWidth = stroke * k;
    ctx.strokeStyle = shape.stroke;
    ctx.stroke();
  }
}

function drawSticker(ctx: CanvasRenderingContext2D, sticker: Sticker, scale: number, canvasHeight: number) {
  const size = sticker.size * (canvasHeight / 1080) * scale;
  ctx.font = `${size}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(sticker.emoji, 0, size * 0.04);
}

/** Fill a mask's area in a clip of w×h centered on the origin (the context already carries the clip's transform). */
function fillMask(ctx: CanvasRenderingContext2D, m: Mask, w: number, h: number) {
  ctx.fillStyle = "#fff";
  if (m.type === "freeform") {
    // Freeform points are absolute positions in the clip; position and rotation do not apply.
    ctx.beginPath();
    m.points.forEach(([px, py], i) => (i === 0 ? ctx.moveTo((px * w) / 2, (py * h) / 2) : ctx.lineTo((px * w) / 2, (py * h) / 2)));
    ctx.closePath();
    ctx.fill();
    return;
  }
  const mw = m.width * w;
  const mh = m.height * h;
  ctx.translate((m.x * w) / 2, (m.y * h) / 2);
  ctx.rotate((m.rotation * Math.PI) / 180);
  // Large enough to reach past the clip's corners at any rotation.
  const far = Math.hypot(w, h) * 2;
  ctx.beginPath();
  switch (m.type) {
    case "rectangle":
      ctx.roundRect(-mw / 2, -mh / 2, mw, mh, (m.roundness * Math.min(mw, mh)) / 2);
      break;
    case "ellipse":
      ctx.ellipse(0, 0, mw / 2, mh / 2, 0, 0, Math.PI * 2);
      break;
    case "diamond":
      ctx.moveTo(0, -mh / 2);
      ctx.lineTo(mw / 2, 0);
      ctx.lineTo(0, mh / 2);
      ctx.lineTo(-mw / 2, 0);
      ctx.closePath();
      break;
    case "star":
      starPath(ctx, mw, mh, 5, 0.45);
      break;
    case "heart":
      heartPath(ctx, mw, mh);
      break;
    case "split":
      // Keeps the side above a line through the mask center.
      ctx.rect(-far, -far, far * 2, far);
      break;
    case "bars":
      // Keeps a horizontal band, like letterbox bars.
      ctx.rect(-far, -mh / 2, far * 2, mh);
      break;
    case "text": {
      const size = mh * 0.8;
      ctx.font = `900 ${size}px "Arial Black", "Segoe UI", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const width = ctx.measureText(m.text || " ").width;
      // Shrink to fit the mask width.
      if (width > mw) ctx.font = `900 ${(size * mw) / width}px "Arial Black", "Segoe UI", sans-serif`;
      ctx.fillText(m.text, 0, 0);
      return;
    }
  }
  ctx.fill();
}

/** Keep (or with invert, cut out) the masked area of a rendered clip layer. */
function applyMask(ctx: CanvasRenderingContext2D, m: Mask, place: { cx: number; cy: number; rotation: number }, w: number, h: number) {
  if (m.type === "freeform" && m.points.length < 3) return;
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const mask = layer(11, W, H);
  if (m.feather > 0) mask.filter = `blur(${m.feather * Math.min(w, h)}px)`;
  mask.translate(place.cx, place.cy);
  mask.rotate(place.rotation);
  fillMask(mask, m, w, h);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = m.invert ? "destination-out" : "destination-in";
  ctx.drawImage(mask.canvas, 0, 0);
  ctx.restore();
}

/** Inverse of a clip's placement: canvas pixel → half-clip mask units. Used to draw freeform masks in the preview. */
export function canvasToClip(project: Project, s: Segment, t: Micros, size: { w: number; h: number }, x: number, y: number): [number, number] {
  const place = placementAt(project, s, t);
  const dx = x - place.cx;
  const dy = y - place.cy;
  const c = Math.cos(-place.rotation);
  const sn = Math.sin(-place.rotation);
  const lx = dx * c - dy * sn;
  const ly = dx * sn + dy * c;
  return [lx / (size.w / 2), ly / (size.h / 2)];
}

/** On-canvas size of a media clip at time `t` (after crop and fit), from the material's probed size. */
export function clipSize(project: Project, s: Segment, t: Micros): { w: number; h: number } | null {
  const material = s.materialId ? project.materials[s.materialId] : undefined;
  const fullW = material?.width;
  const fullH = material?.height;
  if (!fullW || !fullH) return null;
  const sw = Math.max(1, fullW * (1 - s.crop.left - s.crop.right));
  const sh = Math.max(1, fullH * (1 - s.crop.top - s.crop.bottom));
  const fit = Math.min(project.width / sw, project.height / sh) * placementAt(project, s, t).scale;
  return { w: sw * fit, h: sh * fit };
}

let measurer: CanvasRenderingContext2D | null = null;

/** On-canvas size of what a visual clip draws at `t`, before rotation. Null when it has no box (adjustment layers, missing media). */
export function visualSize(project: Project, s: Segment, t: Micros): { w: number; h: number } | null {
  if (s.adjustLayer) return null;
  const H = project.height;
  const scale = placementAt(project, s, t).scale;
  if (s.text) {
    measurer ??= document.createElement("canvas").getContext("2d")!;
    measurer.font = fontFor(s.text, H);
    const lines = s.text.content.split("\n");
    const lineHeight = ((s.text.fontSize * H) / 1080) * 1.25;
    const pad = s.text.background ? lineHeight * 0.3 : 0;
    const width = Math.max(1, ...lines.map((l) => measurer!.measureText(l).width));
    return { w: Math.max(24, (width + pad * 2) * scale), h: Math.max(24, (lineHeight * lines.length + pad) * scale) };
  }
  if (s.shape) {
    const k = (H / 1080) * scale;
    return { w: s.shape.width * k, h: s.shape.kind === "line" ? Math.max(24, s.shape.strokeWidth * k) : s.shape.height * k };
  }
  if (s.sticker) {
    const size = s.sticker.size * (H / 1080) * scale * 1.2;
    return { w: size, h: size };
  }
  return clipSize(project, s, t);
}

/** The topmost clip drawn at a canvas point at `t`. Locked and hidden tracks are passed through. */
export function clipAt(project: Project, t: Micros, x: number, y: number): Segment | null {
  for (const track of project.tracks) {
    if (track.hidden || track.locked || track.kind === "audio") continue;
    const active = track.kind === "video" ? framesNeeded(track, t) : track.segments.filter((s) => isActiveAt(s, t));
    for (const s of [...active].reverse()) {
      const size = visualSize(project, s, t);
      if (!size || placementAt(project, s, t).opacity <= 0) continue;
      const [lx, ly] = canvasToClip(project, s, t, size, x, y);
      if (Math.abs(lx) <= 1 && Math.abs(ly) <= 1) return s;
    }
  }
  return null;
}

const compositeOp = (blend: BlendMode | undefined): GlobalCompositeOperation => (!blend || blend === "normal" ? "source-over" : blend);

// --- Clip rendering ----------------------------------------------------------------------

function mediaSource(pool: MediaPool, s: Segment, material: Material): [CanvasImageSource, number, number] | null {
  if (material.kind === "image") {
    const img = pool.image(material);
    return img.complete && img.naturalWidth ? [img, img.naturalWidth, img.naturalHeight] : null;
  }
  if (!material.hasVideo) return null;
  const decoded = pool.decoded(s.id);
  if (decoded) return [decoded.source, decoded.width, decoded.height];
  const v = pool.video(s, material);
  return v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && v.videoWidth ? [v, v.videoWidth, v.videoHeight] : null;
}

/**
 * Draw one media clip at full opacity into a cleared layer, with its transform, adjustments and
 * effects. Returns the layer and the clip's opacity, or null when there is nothing to draw.
 */
function renderClip(project: Project, s: Segment, t: Micros, pool: MediaPool, slot: number): { canvas: HTMLCanvasElement; opacity: number } | null {
  const material = s.materialId ? project.materials[s.materialId] : undefined;
  if (!material) return null;
  const src = mediaSource(pool, s, material);
  if (!src) return null;
  const [source, fullW, fullH] = src;
  const crop = s.crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
  const sx = crop.left * fullW;
  const sy = crop.top * fullH;
  const sw = Math.max(1, fullW * (1 - crop.left - crop.right));
  const sh = Math.max(1, fullH * (1 - crop.top - crop.bottom));
  const { width: W, height: H } = project;
  const place = placementAt(project, s, t);
  // Effect intensities can be keyframed; resolve them for this instant.
  const local = clampedLocal(s, t);
  const effects = s.effects.map((e) => (s.keyframes[`fx:${e.id}`] ? { ...e, intensity: valueAt(s, `fx:${e.id}`, local) } : e));
  const [dx, dy] = shakeOffset(effects, t, W, H);
  const ctx = layer(slot, W, H);
  const fit = Math.min(W / sw, H / sh) * place.scale;
  const { css, washes } = grade(s, H);
  const filters = [...css, ...effects.flatMap(effectFilter)];
  ctx.translate(place.cx + dx, place.cy + dy);
  ctx.rotate(place.rotation);
  ctx.save();
  if (s.flipX || s.flipY) ctx.scale(s.flipX ? -1 : 1, s.flipY ? -1 : 1);
  ctx.filter = filters.length ? filters.join(" ") : "none";
  ctx.drawImage(source, sx, sy, sw, sh, (-sw * fit) / 2, (-sh * fit) / 2, sw * fit, sh * fit);
  ctx.restore();
  ctx.filter = "none";
  applyWashes(ctx, washes);
  if (effects.length) applyPostEffects(ctx, { ...s, effects }, t, { cx: place.cx + dx, cy: place.cy + dy, w: sw * fit, h: sh * fit });
  if (s.mask) applyMask(ctx, s.mask, { cx: place.cx + dx, cy: place.cy + dy, rotation: place.rotation }, sw * fit, sh * fit);
  return { canvas: ctx.canvas, opacity: place.opacity };
}

export function fontFor(style: TextStyle, canvasHeight: number) {
  const size = (style.fontSize * canvasHeight) / 1080;
  return `${style.italic ? "italic " : ""}${style.bold ? "bold " : ""}${size}px "${style.fontFamily}", "Segoe UI", sans-serif`;
}

/** Draw text centered on the origin. Font size is defined relative to a 1080-pixel-tall canvas. */
function drawText(ctx: CanvasRenderingContext2D, style: TextStyle, scale: number, canvasHeight: number) {
  const lines = style.content.split("\n");
  ctx.scale(scale, scale);
  ctx.font = fontFor(style, canvasHeight);
  ctx.textBaseline = "middle";
  ctx.textAlign = style.align;
  const lineHeight = ((style.fontSize * canvasHeight) / 1080) * 1.25;
  const widths = lines.map((l) => ctx.measureText(l).width);
  const maxWidth = Math.max(1, ...widths);
  const totalHeight = lineHeight * lines.length;
  const anchorX = style.align === "left" ? -maxWidth / 2 : style.align === "right" ? maxWidth / 2 : 0;
  if (style.background) {
    const pad = lineHeight * 0.3;
    ctx.fillStyle = style.background;
    ctx.beginPath();
    ctx.roundRect(-maxWidth / 2 - pad, -totalHeight / 2 - pad / 2, maxWidth + pad * 2, totalHeight + pad, pad);
    ctx.fill();
  }
  lines.forEach((line, i) => {
    const y = -totalHeight / 2 + lineHeight * (i + 0.5);
    if (style.strokeWidth > 0) {
      ctx.lineJoin = "round";
      ctx.lineWidth = (style.strokeWidth * 2 * canvasHeight) / 1080;
      ctx.strokeStyle = style.strokeColor;
      ctx.strokeText(line, anchorX, y);
    }
    ctx.fillStyle = style.color;
    ctx.fillText(line, anchorX, y);
  });
}

// --- Transitions ---------------------------------------------------------------------------

const ease = (p: number) => p * p * (3 - 2 * p);

/** Tint a layer's own pixels toward a color (used for dip-to-black/white). */
function tint(layerCanvas: HTMLCanvasElement, color: string, amount: number) {
  const ctx = layerCanvas.getContext("2d")!;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-atop";
  ctx.globalAlpha = amount;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, layerCanvas.width, layerCanvas.height);
  ctx.restore();
}

type Layer = { canvas: HTMLCanvasElement; opacity: number } | null;

/** Ease-out with a small overshoot, for the elastic push. */
const easeOutBack = (p: number) => {
  const c1 = 1.70158;
  return 1 + (c1 + 1) * (p - 1) ** 3 + c1 * (p - 1) ** 2;
};

/** Deterministic pseudo-random number in [0, 1) from an integer seed (glitch slices must not flicker between renders). */
const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** How far each transition shape must grow (relative to the frame diagonal) to cover the whole frame. */
const SHAPE_COVER: Record<TransitionShape["kind"], number> = { circle: 1.05, rectangle: 1.05, diamond: 2.1, star: 2.9, heart: 2.4, text: 6 };

/**
 * Draw layer `l` only inside a centered transition shape of size `size` (pixels), with soft edges.
 * Reuses the mask machinery so shapes match the clip masks exactly.
 */
function drawInsideShape(ctx: CanvasRenderingContext2D, l: Layer, shape: TransitionShape, size: number, rotation: number) {
  if (!l || size <= 0) return;
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const mask = layer(11, W, H);
  if (shape.softness > 0) mask.filter = `blur(${shape.softness * Math.min(W, H)}px)`;
  mask.translate(W / 2, H / 2);
  mask.rotate(rotation);
  const type = shape.kind === "circle" ? "ellipse" : shape.kind;
  fillMask(mask, { type, x: 0, y: 0, width: size / W, height: size / H, rotation: 0, feather: 0, roundness: 0, invert: false, text: shape.text, points: [] }, W, H);
  const content = layer(12, W, H);
  content.drawImage(l.canvas, 0, 0);
  content.globalCompositeOperation = "destination-in";
  content.drawImage(mask.canvas, 0, 0);
  ctx.save();
  ctx.globalAlpha = l.opacity;
  ctx.drawImage(content.canvas, 0, 0);
  ctx.restore();
}

/** Composite outgoing clip `a` and incoming clip `b` at transition progress `p` (0..1). */
export function drawTransition(ctx: CanvasRenderingContext2D, type: TransitionType, p: number, a: Layer, b: Layer, shape?: TransitionShape) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const e = ease(Math.min(1, Math.max(0, p)));
  const putOn = (c: CanvasRenderingContext2D, l: Layer, alpha = 1, x = 0, y = 0, scale = 1, filter = "none", rotation = 0, op: GlobalCompositeOperation = "source-over") => {
    if (!l || alpha <= 0) return;
    c.save();
    c.globalAlpha = l.opacity * alpha;
    c.globalCompositeOperation = op;
    c.filter = filter;
    c.translate(W / 2 + x, H / 2 + y);
    c.rotate(rotation);
    c.scale(scale, scale);
    c.drawImage(l.canvas, -W / 2, -H / 2);
    c.restore();
  };
  const put = (l: Layer, alpha = 1, x = 0, y = 0, scale = 1, filter = "none", rotation = 0) => putOn(ctx, l, alpha, x, y, scale, filter, rotation);
  // A dissolve adds (1 - e) of one picture to e of the other on a layer of its own. Laying a translucent picture
  // over another translucent one lets the background through and the frame went a quarter darker halfway.
  type Put = [alpha?: number, x?: number, y?: number, scale?: number, filter?: string, rotation?: number];
  const dissolve = (from: Put, to: Put) => {
    const m = layer(15, W, H);
    m.clearRect(0, 0, W, H);
    const [aAlpha = 1, aX = 0, aY = 0, aScale = 1, aFilter = "none", aTurn = 0] = from;
    const [bAlpha = 1, bX = 0, bY = 0, bScale = 1, bFilter = "none", bTurn = 0] = to;
    putOn(m, a, aAlpha, aX, aY, aScale, aFilter, aTurn);
    putOn(m, b, bAlpha, bX, bY, bScale, bFilter, bTurn, "lighter");
    ctx.drawImage(m.canvas, 0, 0);
  };
  const clipped = (l: Layer, path: (c: CanvasRenderingContext2D) => void) => {
    if (!l) return;
    ctx.save();
    ctx.beginPath();
    path(ctx);
    ctx.clip();
    put(l);
    ctx.restore();
  };

  switch (type) {
    case "fade":
      dissolve([1 - e], [e]);
      break;
    case "fadeBlack":
    case "fadeWhite": {
      const color = type === "fadeBlack" ? "#000000" : "#ffffff";
      const toward = 1 - Math.abs(1 - 2 * p);
      const l = p < 0.5 ? a : b;
      if (l) {
        tint(l.canvas, color, toward);
        put(l);
      }
      break;
    }
    case "slideLeft":
      put(a, 1, -e * W);
      put(b, 1, (1 - e) * W);
      break;
    case "slideRight":
      put(a, 1, e * W);
      put(b, 1, -(1 - e) * W);
      break;
    case "slideUp":
      put(a, 1, 0, -e * H);
      put(b, 1, 0, (1 - e) * H);
      break;
    case "slideDown":
      put(a, 1, 0, e * H);
      put(b, 1, 0, -(1 - e) * H);
      break;
    case "wipeLeft":
      put(a);
      clipped(b, (c) => c.rect(W * (1 - e), 0, W * e, H));
      break;
    case "wipeRight":
      put(a);
      clipped(b, (c) => c.rect(0, 0, W * e, H));
      break;
    case "circle":
      put(a);
      clipped(b, (c) => c.arc(W / 2, H / 2, (Math.hypot(W, H) / 2) * e, 0, Math.PI * 2));
      break;
    case "zoom":
      dissolve([1 - e, 0, 0, 1 + 0.35 * e], [e, 0, 0, 0.85 + 0.15 * e]);
      break;
    case "blur": {
      const radius = (36 * H) / 1080 * (1 - Math.abs(1 - 2 * p));
      dissolve([1 - e, 0, 0, 1, `blur(${radius}px)`], [e, 0, 0, 1, `blur(${radius}px)`]);
      break;
    }
    case "wipeUp":
      put(a);
      clipped(b, (c) => c.rect(0, H * (1 - e), W, H * e));
      break;
    case "wipeDown":
      put(a);
      clipped(b, (c) => c.rect(0, 0, W, H * e));
      break;
    case "wipeDiagonal": {
      // The edge is the line x + y = d sweeping from the top-left corner to the bottom-right one.
      const d = e * (W + H);
      put(a);
      clipped(b, (c) => {
        c.moveTo(0, 0);
        c.lineTo(d, 0);
        c.lineTo(0, d);
        c.closePath();
      });
      break;
    }
    case "diamond": {
      const r = (e * (W + H)) / 2;
      put(a);
      clipped(b, (c) => {
        c.moveTo(W / 2, H / 2 - r);
        c.lineTo(W / 2 + r, H / 2);
        c.lineTo(W / 2, H / 2 + r);
        c.lineTo(W / 2 - r, H / 2);
        c.closePath();
      });
      break;
    }
    case "blinds": {
      const bars = 8;
      put(a);
      clipped(b, (c) => {
        for (let i = 0; i < bars; i++) c.rect(0, (i * H) / bars, W, (H / bars) * e);
      });
      break;
    }
    // In the camera moves the incoming clip sits underneath at full opacity, so no background shows through.
    case "spin": {
      // Scaled up while turned just enough that its corners stay outside the frame.
      const turn = -(1 - e) * (Math.PI / 4);
      const c = Math.abs(Math.cos(turn));
      const sn = Math.abs(Math.sin(turn));
      const cover = Math.max(c + (H / W) * sn, c + (W / H) * sn);
      put(b, 1, 0, 0, cover, "none", turn);
      put(a, 1 - e, 0, 0, 1 - 0.5 * e, "none", e * Math.PI);
      break;
    }
    case "zoomIn":
      put(b, 1, 0, 0, 0.8 + 0.2 * e);
      put(a, 1 - e, 0, 0, 1 + e);
      break;
    case "zoomOut":
      put(b, 1, 0, 0, 1.5 - 0.5 * e);
      put(a, 1 - e, 0, 0, 1 - 0.5 * e);
      break;
    case "motionBlur": {
      // A push whose ghost copies trail behind, strongest at full speed mid-way.
      const streak = Math.sin(Math.PI * p) * W * 0.12;
      const copies = 6;
      for (let i = 0; i < copies; i++) {
        const lag = (i / (copies - 1) - 0.5) * streak;
        put(a, 1 / copies + 0.15, -e * W + lag);
        put(b, 1 / copies + 0.15, (1 - e) * W + lag);
      }
      break;
    }
    case "bounce": {
      const k = easeOutBack(Math.min(1, Math.max(0, p)));
      // During the overshoot the incoming clip grows just enough to keep covering the frame.
      const over = Math.max(0, k - 1);
      put(a, 1, -k * W);
      put(b, 1, (1 - k) * W, 0, 1 + 2 * over + (over > 0 ? 0.01 : 0));
      break;
    }
    case "glitch": {
      // Hard cut at the middle, hidden under displaced slices and a color-split ghost.
      const l = p < 0.5 ? a : b;
      const amount = 1 - Math.abs(1 - 2 * p);
      put(l);
      if (!l || amount <= 0) break;
      const frame = Math.floor(p * 24);
      ctx.save();
      ctx.globalAlpha = l.opacity;
      for (let i = 0; i < 10; i++) {
        const y = hash(frame * 31 + i) * H;
        const h = (0.02 + hash(frame * 17 + i) * 0.08) * H;
        const dx = (hash(frame * 7 + i) - 0.5) * W * 0.25 * amount;
        // Every other slice is color-shifted, like a broken RGB signal; the rest of the frame stays clean.
        ctx.filter = i % 2 ? `hue-rotate(${i % 4 === 1 ? 150 : -150}deg) saturate(2.5)` : "none";
        ctx.drawImage(l.canvas, 0, y, W, h, dx, y, W, h);
      }
      ctx.restore();
      break;
    }
    case "flash": {
      dissolve([1 - e], [e]);
      const glow = Math.max(0, 1 - Math.abs(1 - 2 * p) * 1.6);
      ctx.save();
      ctx.globalAlpha = glow;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
      break;
    }
    case "shape": {
      const s = shape ?? { kind: "circle", text: "", direction: "grow", softness: 0.03, rotate: false };
      const cover = Math.hypot(W, H) * SHAPE_COVER[s.kind];
      if (s.direction === "grow") {
        put(a);
        drawInsideShape(ctx, b, s, e * cover, s.rotate ? (1 - e) * (Math.PI / 2) : 0);
        // Shapes with holes (stars, letters) never quite cover the frame; finish with a short dissolve.
        put(b, Math.max(0, (e - 0.75) / 0.25));
      } else {
        put(b);
        // Shapes with holes start already covering less than the frame; fade the outgoing clip in from full.
        put(a, Math.max(0, 1 - e / 0.25));
        drawInsideShape(ctx, a, s, (1 - e) * cover, s.rotate ? e * (Math.PI / 2) : 0);
      }
      break;
    }
  }
}

// --- Frame ---------------------------------------------------------------------------------

/** Clips of a video track that must show a frame at `t` (two during a transition). */
export function framesNeeded(track: Track, t: Micros): Segment[] {
  for (let i = 0; i < track.segments.length; i++) {
    const w = transitionWindow(track, i);
    if (w && t >= w.start && t < w.end) return [w.a, w.b];
  }
  const s = track.segments.find((x) => isActiveAt(x, t));
  return s ? [s] : [];
}

function drawVideoTrack(ctx: CanvasRenderingContext2D, project: Project, track: Track, t: Micros, pool: MediaPool) {
  for (let i = 0; i < track.segments.length; i++) {
    const w = transitionWindow(track, i);
    if (w && t >= w.start && t < w.end) {
      const p = (t - w.start) / (w.end - w.start);
      const a = renderClip(project, w.a, t, pool, 0);
      const b = renderClip(project, w.b, t, pool, 1);
      drawTransition(ctx, w.a.transition!.type, p, a, b, w.a.transition!.shape);
      return;
    }
  }
  const s = track.segments.find((x) => isActiveAt(x, t));
  if (!s) return;
  const clip = renderClip(project, s, t, pool, 0);
  if (!clip || clip.opacity <= 0) return;
  ctx.save();
  ctx.globalAlpha = Math.min(1, clip.opacity);
  ctx.globalCompositeOperation = compositeOp(s.blend);
  ctx.drawImage(clip.canvas, 0, 0);
  ctx.restore();
}

/** Fill the frame with the bottom video track's current clip, scaled to cover and blurred. */
function drawBlurredBackground(ctx: CanvasRenderingContext2D, project: Project, t: Micros, pool: MediaPool) {
  const track = [...project.tracks].reverse().find((tr) => tr.kind === "video" && !tr.hidden);
  const s = track?.segments.find((x) => isActiveAt(x, t));
  const material = s?.materialId ? project.materials[s.materialId] : undefined;
  const src = s && material && mediaSource(pool, s, material);
  if (!src) return;
  const [source, sw, sh] = src;
  const { width: W, height: H } = project;
  // Slightly oversized so the blur's soft edges fall outside the frame.
  const cover = Math.max(W / sw, H / sh) * 1.08;
  ctx.save();
  ctx.filter = `blur(${(project.backgroundBlur * H) / 1080}px) brightness(0.85)`;
  ctx.drawImage(source, (W - sw * cover) / 2, (H - sh * cover) / 2, sw * cover, sh * cover);
  ctx.restore();
}

/**
 * Composite the project at time `t`. Media elements must already show the right frame;
 * the preview engine and exporter take care of seeking before calling this.
 */
export function drawFrame(ctx: CanvasRenderingContext2D, project: Project, t: Micros, pool: MediaPool) {
  const { width: W, height: H } = project;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.filter = "none";
  ctx.fillStyle = project.background;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
  if (project.backgroundMode === "blur") drawBlurredBackground(ctx, project, t, pool);

  // Bottom track first so index 0 ends up on top.
  for (let ti = project.tracks.length - 1; ti >= 0; ti--) {
    const track = project.tracks[ti];
    if (track.hidden || track.kind === "audio") continue;
    if (track.kind === "video") {
      drawVideoTrack(ctx, project, track, t, pool);
      continue;
    }
    drawItems(ctx, project, track, t, true);
  }
}

/** Texts, shapes, stickers and (when `adjust`) adjustment layers of one track. */
function drawItems(ctx: CanvasRenderingContext2D, project: Project, track: Track, t: Micros, adjust: boolean) {
  const H = project.height;
  for (const s of track.segments) {
    if (!isActiveAt(s, t) || !(s.text || s.shape || s.sticker || s.adjustLayer)) continue;
    const place = placementAt(project, s, t);
    if (place.opacity <= 0) continue;
    if (s.adjustLayer) {
      if (adjust) applyAdjustmentLayer(ctx, s, place.opacity);
      continue;
    }
    ctx.save();
    ctx.globalAlpha = Math.min(1, place.opacity);
    ctx.globalCompositeOperation = compositeOp(s.blend);
    ctx.translate(place.cx, place.cy);
    ctx.rotate(place.rotation);
    if (s.text) drawText(ctx, s.text, place.scale, H);
    else if (s.shape) drawShape(ctx, s.shape, place.scale, H);
    else if (s.sticker) drawSticker(ctx, s.sticker, place.scale, H);
    ctx.restore();
  }
}

/**
 * Only what sits above the video (texts, shapes, stickers), on a transparent canvas. The export lays it over
 * footage that FFmpeg decodes and encodes by itself.
 */
export function drawOverlay(ctx: CanvasRenderingContext2D, project: Project, t: Micros) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.filter = "none";
  ctx.clearRect(0, 0, project.width, project.height);
  ctx.restore();
  for (let ti = project.tracks.length - 1; ti >= 0; ti--) {
    const track = project.tracks[ti];
    if (track.hidden || track.kind === "audio" || track.kind === "video") continue;
    drawItems(ctx, project, track, t, false);
  }
}

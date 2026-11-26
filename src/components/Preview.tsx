import { useEffect, useRef, useState } from "react";
import { useEditor } from "../store";
import { PreviewEngine } from "../engine/previewEngine";
import { findSegment, isActiveAt, projectDuration, valueAt } from "../model/project";
import { canvasToClip, clipAt, clipSize, placementAt, visualSize } from "../engine/compositor";
import type { Project, Segment } from "../model/types";
import { useUi, withGroups, type GuideKind } from "../ui";
import { timecode } from "../model/time";
import { Icon } from "./controls";

const GUIDE_OPTIONS: { value: GuideKind; label: string }[] = [
  { value: "none", label: "Sem guias" },
  { value: "thirds", label: "Regra dos terços" },
  { value: "grid", label: "Grade" },
  { value: "center", label: "Centro" },
  { value: "tiktok", label: "Área segura TikTok" },
  { value: "reels", label: "Área segura Reels" },
  { value: "shorts", label: "Área segura Shorts" },
];

/**
 * Areas covered by each app's interface on a 9:16 frame, as fractions of width/height
 * (top, right, bottom, left). Approximate, from the platforms' published safe-zone templates.
 */
const SAFE_ZONES: Record<"tiktok" | "reels" | "shorts", [number, number, number, number]> = {
  tiktok: [0.08, 0.12, 0.2, 0.04],
  reels: [0.12, 0.1, 0.2, 0.05],
  shorts: [0.1, 0.13, 0.22, 0.05],
};

/** Composition and safe-area overlays drawn above the preview (never exported). */
function Guides({ kind, width, height }: { kind: GuideKind; width: number; height: number }) {
  if (kind === "none") return null;
  const lines: { x1: number; y1: number; x2: number; y2: number }[] = [];
  const split = (n: number) => {
    for (let i = 1; i < n; i++) {
      lines.push({ x1: (i / n) * 100, y1: 0, x2: (i / n) * 100, y2: 100 });
      lines.push({ x1: 0, y1: (i / n) * 100, x2: 100, y2: (i / n) * 100 });
    }
  };
  if (kind === "thirds") split(3);
  if (kind === "grid") split(6);
  if (kind === "center") split(2);
  const zone = kind === "tiktok" || kind === "reels" || kind === "shorts" ? SAFE_ZONES[kind] : null;
  return (
    <svg className="guides" viewBox="0 0 100 100" preserveAspectRatio="none">
      {lines.map((l, i) => (
        <line key={i} {...l} vectorEffect="non-scaling-stroke" />
      ))}
      {zone && (
        <>
          <path
            className="unsafe"
            fillRule="evenodd"
            d={`M0,0H100V100H0Z M${zone[3] * 100},${zone[0] * 100}H${100 - zone[1] * 100}V${100 - zone[2] * 100}H${zone[3] * 100}Z`}
          />
          {width > height && <text x="50" y="50" textAnchor="middle">feito para vídeo vertical</text>}
        </>
      )}
    </svg>
  );
}

const PLAY_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/** Corners of the freeform mask being drawn, positioned over the preview. */
function MaskPoints({ project, segment, playhead }: { project: Project; segment: Segment; playhead: number }) {
  const size = clipSize(project, segment, playhead);
  if (!size || !segment.mask) return null;
  const place = placementAt(project, segment, playhead);
  const toCanvas = ([px, py]: [number, number]) => {
    const lx = (px * size.w) / 2;
    const ly = (py * size.h) / 2;
    const c = Math.cos(place.rotation);
    const s = Math.sin(place.rotation);
    return [((place.cx + lx * c - ly * s) / project.width) * 100, ((place.cy + lx * s + ly * c) / project.height) * 100];
  };
  const pts = segment.mask.points.map(toCanvas);
  return (
    <svg className="mask-points" viewBox="0 0 100 100" preserveAspectRatio="none">
      {pts.length > 1 && <polygon points={pts.map((p) => p.join(",")).join(" ")} vectorEffect="non-scaling-stroke" />}
      {pts.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={0.8} vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}

const MIN_SCALE = 0.05;
const MAX_SCALE = 5;
const SNAP_DEGREES = 3;
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const milli = (v: number) => Math.round(v * 1000) / 1000;

/** Runs `onMove` once the pointer really moves, so a plain click leaves no undo step. */
function dragGesture(e: React.PointerEvent, onMove: (ev: PointerEvent) => void) {
  const origin = { x: e.clientX, y: e.clientY };
  let started = false;
  const move = (ev: PointerEvent) => {
    if (!started) {
      if (Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) < 3) return;
      started = true;
      useEditor.getState().checkpoint();
    }
    onMove(ev);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/** Outline of the selected clip over the preview: corners resize it, the top knob turns it. */
function TransformBox({ project, segment, playhead, fit, canvas, onBody }: { project: Project; segment: Segment; playhead: number; fit: number; canvas: () => HTMLCanvasElement | null; onBody: (e: React.PointerEvent) => void }) {
  const size = visualSize(project, segment, playhead);
  if (!size) return null;
  const place = placementAt(project, segment, playhead);
  const id = segment.id;
  const center = () => {
    const r = canvas()!.getBoundingClientRect();
    return { x: r.left + (place.cx / project.width) * r.width, y: r.top + (place.cy / project.height) * r.height };
  };
  const resize = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const c = center();
    const startDistance = Math.max(1, Math.hypot(e.clientX - c.x, e.clientY - c.y));
    const startScale = place.scale;
    dragGesture(e, (ev) => {
      const next = (startScale * Math.hypot(ev.clientX - c.x, ev.clientY - c.y)) / startDistance;
      useEditor.getState().setAnimated(id, "scale", milli(clamp(next, MIN_SCALE, MAX_SCALE)), { history: false });
    });
  };
  const turn = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const c = center();
    const angle = (ev: { clientX: number; clientY: number }) => (Math.atan2(ev.clientY - c.y, ev.clientX - c.x) * 180) / Math.PI;
    const startAngle = angle(e);
    const startRotation = (place.rotation * 180) / Math.PI;
    dragGesture(e, (ev) => {
      let next = startRotation + angle(ev) - startAngle;
      next = ((((next + 180) % 360) + 360) % 360) - 180;
      // Shift turns in 15° steps; otherwise it only catches on the right angles.
      const stepped = ev.shiftKey ? Math.round(next / 15) * 15 : Math.round(next / 90) * 90;
      if (ev.shiftKey || Math.abs(next - stepped) < SNAP_DEGREES) next = stepped;
      useEditor.getState().setAnimated(id, "rotation", Math.round(next * 10) / 10, { history: false });
    });
  };
  return (
    <div
      className="transform-box"
      onPointerDown={onBody}
      style={{ left: place.cx * fit, top: place.cy * fit, width: size.w * fit, height: size.h * fit, transform: `translate(-50%, -50%) rotate(${place.rotation}rad)` }}
    >
      <i className="tb-rotate" title="Girar (Shift: de 15 em 15°)" onPointerDown={turn} />
      {(["nw", "ne", "sw", "se"] as const).map((corner) => (
        <i key={corner} className={`tb-corner ${corner}`} title="Redimensionar" onPointerDown={resize} />
      ))}
    </div>
  );
}

export function Preview() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const project = useEditor((s) => s.project);
  const playing = useEditor((s) => s.playing);
  const playhead = useEditor((s) => s.playhead);
  const setPlaying = useEditor((s) => s.setPlaying);
  const duration = projectDuration(project);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const maskDrawing = useUi((s) => s.maskDrawing);
  const guides = useUi((s) => s.guides);
  const playRate = useUi((s) => s.playRate);
  const playReverse = useUi((s) => s.playReverse);
  const setUi = useUi((s) => s.set);
  const drawingMask = maskDrawing ? findSegment(project, maskDrawing)?.segment : undefined;
  const selectedId = useEditor((s) => s.selectedId);
  const selected = selectedId ? findSegment(project, selectedId) : null;
  const boxed = selected && selected.track.kind !== "audio" && !selected.track.locked && !selected.track.hidden && !playing && !drawingMask && isActiveAt(selected.segment, playhead) ? selected.segment : null;

  useEffect(() => {
    if (!canvasRef.current) return;
    const engine = new PreviewEngine(canvasRef.current);
    return () => engine.destroy();
  }, []);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setStage({ w: entry.contentRect.width, h: entry.contentRect.height }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Largest box with the project's aspect ratio that fits the stage.
  const fit = Math.min(stage.w / project.width, stage.h / project.height) || 0;

  // A click picks the clip under the pointer; dragging moves it (sets a keyframe if the clip is animated).
  const onPointerDown = (e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (e.button !== 0 || !canvas) return;
    const state = useEditor.getState();
    const found = state.selectedId ? findSegment(state.project, state.selectedId) : null;
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * state.project.width;
    const y = ((e.clientY - rect.top) / rect.height) * state.project.height;
    if (found && found.track.kind !== "audio" && !found.track.locked && maskDrawing === found.segment.id && found.segment.mask?.type === "freeform") {
      // Each click adds a corner of the freeform mask, in the clip's own coordinates.
      const size = clipSize(state.project, found.segment, state.playhead);
      if (!size) return;
      const point = canvasToClip(state.project, found.segment, state.playhead, size, x, y).map((v) => Math.round(v * 1000) / 1000) as [number, number];
      state.updateSegment(found.segment.id, (s) => void s.mask?.points.push(point));
      return;
    }
    const target = clipAt(state.project, state.playhead, x, y);
    if (!target) {
      state.select(null);
      return;
    }
    const id = target.id;
    if (id !== state.selectedId) state.selectMany([id, ...withGroups([id])]);
    const local = state.playhead - target.start;
    const startX = valueAt(target, "x", local);
    const startY = valueAt(target, "y", local);
    const origin = { x: e.clientX, y: e.clientY };
    dragGesture(e, (ev) => {
      const editor = useEditor.getState();
      editor.setAnimated(id, "x", milli(clamp(startX + ((ev.clientX - origin.x) / rect.width) * 2, -2, 2)), { history: false });
      editor.setAnimated(id, "y", milli(clamp(startY + ((ev.clientY - origin.y) / rect.height) * 2, -2, 2)), { history: false });
    });
  };

  return (
    <section className="panel preview">
      <div className="preview-stage" ref={stageRef}>
        <div className="canvas-fit" style={{ width: project.width * fit, height: project.height * fit }}>
          <canvas ref={canvasRef} onPointerDown={onPointerDown} style={drawingMask ? { cursor: "crosshair" } : undefined} />
          <Guides kind={guides} width={project.width} height={project.height} />
          {drawingMask?.mask && <MaskPoints project={project} segment={drawingMask} playhead={playhead} />}
          {boxed && <TransformBox project={project} segment={boxed} playhead={playhead} fit={fit} canvas={() => canvasRef.current} onBody={onPointerDown} />}
        </div>
        {drawingMask && <div className="preview-banner">Clique no preview para marcar os cantos da máscara · Esc ou "Concluir desenho" para terminar</div>}
      </div>
      <div className="transport">
        <span className="timecode">
          <b>{timecode(playhead, project.fps)}</b> / {timecode(duration, project.fps)}
        </span>
        <div className="transport-center">
          <button
            className={`play-back${playing && playReverse ? " toggle-on" : ""}`}
            onClick={() => {
              if (playing && playReverse) setPlaying(false);
              else {
                setUi({ playReverse: true });
                setPlaying(true);
              }
            }}
            title="Assistir de trás para frente (sem som)"
          >
            <Icon name="playBack" />
          </button>
          <button className="play-btn" onClick={() => setPlaying(!playing)} title="Reproduzir/Pausar (Espaço)">
            <Icon name={playing ? "pause" : "play"} />
          </button>
          <select className="rate-select" value={playRate} onChange={(e) => setUi({ playRate: Number(e.target.value) })} title="Velocidade para assistir. Não muda o vídeo exportado.">
            {PLAY_RATES.map((rate) => (
              <option key={rate} value={rate}>
                {String(rate).replace(".", ",")}x
              </option>
            ))}
          </select>
        </div>
        <div className="transport-right">
          <select className="guides-select" value={guides} title="Guias" onChange={(e) => setUi({ guides: e.target.value as GuideKind })}>
            {GUIDE_OPTIONS.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </select>
          <span className="canvas-info">
            {project.width}×{project.height} · {project.fps} fps
          </span>
        </div>
      </div>
    </section>
  );
}

import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { useEditor } from "../store";
import { findSegment } from "../model/project";
import type { Crop } from "../model/types";
import { mediaUrl } from "../engine/mediaPool";
import { sourceSecondsAt } from "../engine/compositor";

/** Which clip the crop window is open for (null: closed). */
export const useCropDialog = create<{ segmentId: string | null }>(() => ({ segmentId: null }));
export const openCrop = (segmentId: string | null) => segmentId && useCropDialog.setState({ segmentId });

const ASPECTS: { label: string; value: number | null }[] = [
  { label: "Livre", value: null },
  { label: "16:9", value: 16 / 9 },
  { label: "9:16", value: 9 / 16 },
  { label: "1:1", value: 1 },
  { label: "4:5", value: 4 / 5 },
  { label: "4:3", value: 4 / 3 },
];
const MIN = 0.05;
type Rect = { x: number; y: number; w: number; h: number };
type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

const toRect = (c: Crop): Rect => ({ x: c.left, y: c.top, w: 1 - c.left - c.right, h: 1 - c.top - c.bottom });
const toCrop = (r: Rect): Crop => ({ left: r.x, top: r.y, right: Math.max(0, 1 - r.x - r.w), bottom: Math.max(0, 1 - r.y - r.h) });
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** The biggest rectangle of `aspect` (picture proportions) that fits in the frame, centred on `around`. */
function fitAspect(around: Rect, aspect: number, W: number, H: number): Rect {
  const a = (aspect * H) / W; // the same aspect, in the 0–1 units of this frame
  let w = 1;
  let h = w / a;
  if (h > 1) {
    h = 1;
    w = h * a;
  }
  const cx = around.x + around.w / 2;
  const cy = around.y + around.h / 2;
  return { w, h, x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h) };
}

/**
 * Crop on the picture: the whole frame of the clip's video with a box to drag and resize, like CapCut. What is
 * outside the box is hidden; the rest fills the clip's place on screen. Useful for a webcam with too much room around.
 */
export function CropDialog() {
  const segmentId = useCropDialog((s) => s.segmentId);
  if (!segmentId) return null;
  return <CropWindow key={segmentId} segmentId={segmentId} onClose={() => useCropDialog.setState({ segmentId: null })} />;
}

function CropWindow({ segmentId, onClose }: { segmentId: string; onClose: () => void }) {
  const project = useEditor((s) => s.project);
  const found = findSegment(project, segmentId);
  const segment = found?.segment;
  const material = segment?.materialId ? project.materials[segment.materialId] : undefined;
  const [rect, setRect] = useState<Rect>(() => (segment ? toRect(segment.crop) : { x: 0, y: 0, w: 1, h: 1 }));
  const [aspect, setAspect] = useState<number | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);

  const W = material?.width || 1920;
  const H = material?.height || 1080;
  const scale = Math.min(Math.min(820, window.innerWidth - 140) / W, Math.min(460, window.innerHeight - 330) / H);
  const sw = Math.round(W * scale);
  const sh = Math.round(H * scale);

  // The frame under the playhead (or the clip's first frame when the playhead is outside it).
  useEffect(() => {
    const el = video.current;
    if (!el || !segment || !material) return;
    const t = useEditor.getState().playhead;
    const inside = t >= segment.start && t < segment.start + segment.duration;
    const at = sourceSecondsAt(segment, inside ? t : segment.start, material);
    const go = () => {
      el.currentTime = Math.max(0, at);
    };
    if (el.readyState >= 1) go();
    else el.addEventListener("loadedmetadata", go, { once: true });
  }, []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  if (!segment || !material) return null;

  const grab = (e: React.PointerEvent, handle: Handle) => {
    e.preventDefault();
    e.stopPropagation();
    const box = stage.current!.getBoundingClientRect();
    const start = { ...rect };
    const x0 = e.clientX;
    const y0 = e.clientY;
    const a = aspect ? (aspect * H) / W : null;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / box.width;
      const dy = (ev.clientY - y0) / box.height;
      if (handle === "move") {
        setRect({ ...start, x: clamp(start.x + dx, 0, 1 - start.w), y: clamp(start.y + dy, 0, 1 - start.h) });
        return;
      }
      let { x, y, w, h } = start;
      const right = start.x + start.w;
      const bottom = start.y + start.h;
      if (handle.includes("w")) x = clamp(start.x + dx, 0, right - MIN);
      if (handle.includes("e")) w = clamp(start.w + dx, MIN, 1 - start.x);
      if (handle.includes("n")) y = clamp(start.y + dy, 0, bottom - MIN);
      if (handle.includes("s")) h = clamp(start.h + dy, MIN, 1 - start.y);
      if (handle.includes("w")) w = right - x;
      if (handle.includes("n")) h = bottom - y;
      if (a) {
        // Locked proportions: the side that was dragged leads, the other follows, and it all stays in the frame.
        if (handle === "n" || handle === "s") w = h * a;
        else if (handle === "e" || handle === "w") h = w / a;
        else if (w / h > a) w = h * a;
        else h = w / a;
        if (w > 1) (w = 1), (h = w / a);
        if (h > 1) (h = 1), (w = h * a);
        if (handle.includes("w")) x = right - w;
        else if (handle === "n" || handle === "s") x = start.x + (start.w - w) / 2;
        if (handle.includes("n")) y = bottom - h;
        else if (handle === "e" || handle === "w") y = start.y + (start.h - h) / 2;
        x = clamp(x, 0, 1 - w);
        y = clamp(y, 0, 1 - h);
      }
      setRect({ x, y, w, h });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const pick = (value: number | null) => {
    setAspect(value);
    if (value) setRect(fitAspect(rect, value, W, H));
  };
  const apply = () => {
    const crop = toCrop(rect);
    const none = crop.left < 0.001 && crop.top < 0.001 && crop.right < 0.001 && crop.bottom < 0.001;
    useEditor.getState().updateSegment(segmentId, (s) => void (s.crop = none ? { left: 0, top: 0, right: 0, bottom: 0 } : crop), { history: true });
    onClose();
  };
  const pixels = `${Math.round(rect.w * W)} × ${Math.round(rect.h * H)}`;

  return (
    <div className="modal-backdrop">
      <div className="modal crop-modal" style={{ width: Math.max(560, sw + 40) }}>
        <h2>Recortar o vídeo</h2>
        <p className="modal-note">Arraste a caixa e as bordas para deixar só a parte que importa (por exemplo, você na webcam, sem o fundo dos lados). O que fica fora some, e o resto ocupa o lugar do clipe.</p>
        <div className="crop-stage" ref={stage} style={{ width: sw, height: sh }}>
          {material.kind === "image" ? (
            <img src={mediaUrl(material.path)} alt="" draggable={false} />
          ) : (
            <video ref={video} src={mediaUrl(material.path)} muted preload="auto" />
          )}
          {/* The shade is clipped to the picture; the box and its handles are not, so the edges can always be grabbed. */}
          <div className="crop-shade">
            <i style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }} />
          </div>
          <div className="crop-box" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }} onPointerDown={(e) => grab(e, "move")}>
            <i className="crop-grid" />
            {HANDLES.map((h) => (
              <b key={h} className={`crop-handle h-${h}`} onPointerDown={(e) => grab(e, h)} />
            ))}
          </div>
        </div>
        <div className="crop-bar">
          <div className="segmented crop-presets">
            {ASPECTS.map((a) => (
              <button key={a.label} className={aspect === a.value ? "active" : ""} onClick={() => pick(a.value)} title={a.value ? `Mantém a proporção ${a.label}` : "Qualquer formato"}>
                {a.label}
              </button>
            ))}
          </div>
          <span className="crop-size">{pixels}</span>
        </div>
        <div className="modal-actions">
          <button onClick={() => (setRect({ x: 0, y: 0, w: 1, h: 1 }), setAspect(null))}>Redefinir</button>
          <span className="grow" />
          <button onClick={onClose}>Cancelar</button>
          <button className="primary" onClick={apply}>
            Aplicar
          </button>
        </div>
      </div>
    </div>
  );
}

import { useRef } from "react";
import { useEditor } from "../store";
import { useUi } from "../ui";
import type { BlendMode, Easing, Mask, MaskType, Segment, ShapeStyle } from "../model/types";
import { MASK_TYPES } from "../model/types";
import { bezierAt, createMask, easingCurve, keyframeNear } from "../model/project";
import { Section, SliderRow, Toggle } from "./controls";

export const BLEND_LABELS: Record<BlendMode, string> = {
  normal: "Normal",
  darken: "Escurecer",
  multiply: "Multiplicar",
  "color-burn": "Superexposição de cor",
  lighten: "Clarear",
  screen: "Tela",
  lighter: "Adição",
  "color-dodge": "Subexposição de cor",
  overlay: "Sobrepor",
  "soft-light": "Luz suave",
  "hard-light": "Luz direta",
  difference: "Diferença",
  exclusion: "Exclusão",
  hue: "Matiz",
  saturation: "Saturação",
  color: "Cor",
  luminosity: "Luminosidade",
};

const EASING_OPTIONS: { label: string; value: Exclude<Easing, unknown[]> }[] = [
  { label: "Linear", value: "linear" },
  { label: "Entrada suave", value: "easeIn" },
  { label: "Saída suave", value: "easeOut" },
  { label: "Suave", value: "easeInOut" },
  { label: "Constante", value: "hold" },
];

const CURVE = 132;
const PAD = 14;

/**
 * Curve of the keyframes at the playhead: presets plus a bezier editor with two draggable handles.
 * The curve shapes the change from these keyframes to the next ones.
 */
export function EasingSection({ segment, local, fps }: { segment: Segment; local: number; fps: number }) {
  const setKeyframeEasing = useEditor((s) => s.setKeyframeEasing);
  const checkpoint = useEditor((s) => s.checkpoint);
  const frame = Object.values(segment.keyframes)
    .map((frames) => keyframeNear(frames, local, fps))
    .find(Boolean);
  const easing = frame?.easing ?? "linear";
  const curve = easingCurve(easing);
  const dragging = useRef<0 | 1 | null>(null);
  const toSvg = (x: number, y: number) => [PAD + x * CURVE, PAD + (1 - y) * CURVE] as const;
  const path = curve
    ? Array.from({ length: 41 }, (_, i) => {
        const [x, y] = toSvg(i / 40, bezierAt(curve, i / 40));
        return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(" ")
    : `M${toSvg(0, 0).join(",")} L${toSvg(1, 0).join(",")} L${toSvg(1, 1).join(",")}`;

  const drag = (e: React.PointerEvent<SVGSVGElement>) => {
    if (dragging.current === null || !curve) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left - PAD) / CURVE));
    const y = Math.min(1.5, Math.max(-0.5, 1 - (e.clientY - r.top - PAD) / CURVE));
    const next: [number, number, number, number] = [...curve];
    next[dragging.current * 2] = Math.round(x * 100) / 100;
    next[dragging.current * 2 + 1] = Math.round(y * 100) / 100;
    useEditor.getState().updateSegment(
      segment.id,
      (s) => {
        for (const frames of Object.values(s.keyframes)) {
          const k = keyframeNear(frames, local, fps);
          if (k) k.easing = next;
        }
      },
      { history: false },
    );
  };

  return (
    <Section title="Curva da animação">
      <div className="segmented easing-presets">
        {EASING_OPTIONS.map((o) => (
          <button key={o.value} className={easing === o.value ? "active" : ""} onClick={() => setKeyframeEasing(segment.id, local, o.value)}>
            {o.label}
          </button>
        ))}
      </div>
      <svg
        className="curve-editor"
        width={CURVE + PAD * 2}
        height={CURVE + PAD * 2}
        onPointerMove={drag}
        onPointerUp={() => (dragging.current = null)}
        onPointerLeave={() => (dragging.current = null)}
      >
        <rect x={PAD} y={PAD} width={CURVE} height={CURVE} className="curve-box" />
        <path d={path} className="curve-line" />
        {curve &&
          ([0, 1] as const).map((i) => {
            const [hx, hy] = toSvg(curve[i * 2], curve[i * 2 + 1]);
            const [ax, ay] = i === 0 ? toSvg(0, 0) : toSvg(1, 1);
            return (
              <g key={i}>
                <line x1={ax} y1={ay} x2={hx} y2={hy} className="curve-arm" />
                <circle
                  cx={hx}
                  cy={hy}
                  r={6}
                  className="curve-handle"
                  onPointerDown={(e) => {
                    checkpoint();
                    dragging.current = i;
                    (e.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture(e.pointerId);
                  }}
                />
              </g>
            );
          })}
      </svg>
      <p className="hint">Vale para os keyframes no cursor e define como o valor chega ao keyframe seguinte. Arraste as alças para uma curva própria.</p>
    </Section>
  );
}

const MASK_LABELS: Record<MaskType, string> = {
  rectangle: "Retângulo",
  ellipse: "Elipse",
  diamond: "Losango",
  star: "Estrela",
  heart: "Coração",
  split: "Divisão",
  bars: "Faixas de cinema",
  text: "Texto",
  freeform: "Desenho livre",
};

export function MaskSection({ segment, update }: { segment: Segment; update: (fn: (s: Segment) => void, history: boolean) => void }) {
  const mask = segment.mask;
  const drawing = useUi((s) => s.maskDrawing === segment.id);
  const setUi = useUi((s) => s.set);
  const patch = (p: Partial<Mask>, history: boolean) => update((s) => s.mask && Object.assign(s.mask, p), history);
  const geometric = mask && !["freeform", "split"].includes(mask.type);
  return (
    <Section title="Máscara" reset={{ visible: Boolean(mask), label: "Remover", onClick: () => update((s) => void (s.mask = null), true) }}>
      <div className="mask-grid">
        {MASK_TYPES.map((t) => (
          <button
            key={t}
            className={mask?.type === t ? "active" : ""}
            onClick={() => {
              update((s) => void (s.mask = mask ? { ...createMask(t), feather: mask.feather, invert: mask.invert } : createMask(t)), true);
              setUi({ maskDrawing: t === "freeform" ? segment.id : null });
            }}
          >
            {MASK_LABELS[t]}
          </button>
        ))}
      </div>
      {mask && (
        <>
          {mask.type === "freeform" && (
            <div className="mask-draw">
              <button className={drawing ? "primary" : ""} onClick={() => setUi({ maskDrawing: drawing ? null : segment.id })}>
                {drawing ? "Concluir desenho" : "Desenhar no preview"}
              </button>
              <button disabled={!mask.points.length} onClick={() => patch({ points: mask.points.slice(0, -1) }, true)}>
                Desfazer ponto
              </button>
              <span className="hint">{mask.points.length} pontos</span>
            </div>
          )}
          {mask.type === "text" && (
            <label className="field">
              <span>Texto da máscara</span>
              <input value={mask.text} onChange={(e) => patch({ text: e.target.value }, false)} />
            </label>
          )}
          {mask.type !== "freeform" && (
            <>
              <SliderRow label="Posição X" min={-1.5} max={1.5} step={0.01} value={mask.x} defaultValue={0} onChange={(v, o) => patch({ x: v }, o.history)} />
              <SliderRow label="Posição Y" min={-1.5} max={1.5} step={0.01} value={mask.y} defaultValue={0} onChange={(v, o) => patch({ y: v }, o.history)} />
              <SliderRow label="Rotação" min={-180} max={180} step={0.5} unit="°" value={mask.rotation} defaultValue={0} onChange={(v, o) => patch({ rotation: v }, o.history)} />
            </>
          )}
          {geometric && mask.type !== "bars" && (
            <SliderRow label="Largura" min={0.02} max={2} step={0.01} value={mask.width} defaultValue={createMask(mask.type).width} onChange={(v, o) => patch({ width: v }, o.history)} />
          )}
          {geometric && (
            <SliderRow label="Altura" min={0.02} max={2} step={0.01} value={mask.height} defaultValue={createMask(mask.type).height} onChange={(v, o) => patch({ height: v }, o.history)} />
          )}
          {mask.type === "rectangle" && <SliderRow label="Cantos" min={0} max={1} step={0.01} value={mask.roundness} defaultValue={0} onChange={(v, o) => patch({ roundness: v }, o.history)} />}
          <SliderRow label="Suavizar" min={0} max={0.5} step={0.005} value={mask.feather} defaultValue={0.02} onChange={(v, o) => patch({ feather: v }, o.history)} />
          <Toggle label="Inverter" checked={mask.invert} onChange={(v) => patch({ invert: v }, true)} />
        </>
      )}
    </Section>
  );
}

export function ShapeSection({ shape, onChange }: { shape: ShapeStyle; onChange: (patch: Partial<ShapeStyle>, history: boolean) => void }) {
  const checkpoint = useEditor((s) => s.checkpoint);
  return (
    <Section title="Forma">
      <SliderRow label="Largura" min={10} max={2000} step={1} value={shape.width} onChange={(v, o) => onChange({ width: v }, o.history)} />
      {shape.kind !== "line" && <SliderRow label="Altura" min={10} max={2000} step={1} value={shape.height} onChange={(v, o) => onChange({ height: v }, o.history)} />}
      {shape.kind === "rectangle" && <SliderRow label="Cantos" min={0} max={1} step={0.01} value={shape.roundness} defaultValue={0} onChange={(v, o) => onChange({ roundness: v }, o.history)} />}
      {(shape.kind === "polygon" || shape.kind === "star") && <SliderRow label="Pontas" min={3} max={12} step={1} value={shape.sides} onChange={(v, o) => onChange({ sides: v }, o.history)} />}
      <div className="inline-fields">
        {shape.kind !== "line" && (
          <>
            <Toggle label="Preenchimento" checked={shape.fill !== null} onChange={(v) => onChange({ fill: v ? "#22c3b5" : null }, true)} />
            {shape.fill !== null && <input type="color" value={shape.fill} onFocus={checkpoint} onChange={(e) => onChange({ fill: e.target.value }, false)} />}
          </>
        )}
      </div>
      <div className="inline-fields">
        <label className="field compact">
          <span>Contorno</span>
          <input type="color" value={shape.stroke} onFocus={checkpoint} onChange={(e) => onChange({ stroke: e.target.value }, false)} />
        </label>
        <SliderRow label="Espessura" min={0} max={60} step={0.5} value={shape.strokeWidth} onChange={(v, o) => onChange({ strokeWidth: v }, o.history)} />
      </div>
    </Section>
  );
}

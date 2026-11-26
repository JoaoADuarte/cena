import { useEditor } from "../store";

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  format?: (v: number) => string;
  /** Live updates while dragging; the first change of a gesture records one undo step. */
  onChange: (value: number, options: { history: boolean }) => void;
  keyframe?: { active: boolean; hasAny: boolean; onToggle: () => void };
  /** Shows a reset button whenever the value differs from this. */
  defaultValue?: number;
  /** Replaces the default reset (onChange(defaultValue)), e.g. to also drop keyframes. */
  onReset?: () => void;
  /** Overrides the value comparison, e.g. when keyframes exist. */
  modified?: boolean;
}

export function SliderRow({ label, value, min, max, step, unit, format, onChange, keyframe, defaultValue, onReset, modified }: SliderProps) {
  const checkpoint = useEditor((s) => s.checkpoint);
  const fmt = (v: number) => (format ? format(v) : `${Math.round(v * 100) / 100}${unit ?? ""}`);
  const shown = fmt(value);
  const canReset = defaultValue !== undefined && (modified ?? Math.abs(value - defaultValue) > step / 2);
  const reset = () => {
    if (!canReset || defaultValue === undefined) return;
    if (onReset) onReset();
    else onChange(defaultValue, { history: true });
  };
  // Dragging the name or the number sideways changes the value; Shift for fine control.
  const scrub = (e: React.PointerEvent<HTMLElement>) => {
    const el = e.currentTarget;
    if (e.button !== 0 || (e.target as HTMLElement).closest("button") || document.activeElement === el) return;
    const startX = e.clientX;
    const perPixel = Math.max(step, (max - min) / 300);
    let started = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!started) {
        if (Math.abs(dx) < 3) return;
        started = true;
        checkpoint();
        el.setPointerCapture(ev.pointerId);
        el.blur();
      }
      const raw = value + dx * (ev.shiftKey ? perPixel / 10 : perPixel);
      const stepped = Math.round((Math.round(raw / step) * step) * 1e6) / 1e6;
      onChange(Math.min(max, Math.max(min, stepped)), { history: false });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div className="slider-row">
      <span className="slider-label" onPointerDown={scrub} onDoubleClick={reset} title={canReset ? "Arraste para os lados para ajustar · clique duas vezes para voltar ao padrão" : "Arraste para os lados para ajustar"}>
        <span className="slider-label-text" title={label}>
          {label}
        </span>
        {canReset && (
          <button type="button" className="reset-btn" title={`Voltar ao padrão (${fmt(defaultValue ?? 0)})`} onClick={reset}>
            <Icon name="reset" />
          </button>
        )}
      </span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={checkpoint}
        onKeyDown={checkpoint}
        onChange={(e) => onChange(Number(e.target.value), { history: false })}
      />
      <input
        className="slider-number"
        type="number"
        aria-label={label}
        step={step}
        value={Math.round(value * 1000) / 1000}
        title={`${shown} · arraste para os lados para ajustar`}
        onPointerDown={scrub}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)), { history: true });
        }}
      />
      {keyframe && (
        <button
          type="button"
          className={`kf-btn${keyframe.active ? " on" : keyframe.hasAny ? " some" : ""}`}
          title={keyframe.active ? "Remover keyframe" : "Adicionar keyframe"}
          onClick={(e) => {
            e.preventDefault();
            keyframe.onToggle();
          }}
        >
          ◆
        </button>
      )}
    </div>
  );
}

interface SectionProps {
  title: string;
  children: React.ReactNode;
  /** Header button that puts the whole section back to its defaults; hidden while there is nothing to reset. */
  reset?: { visible: boolean; onClick: () => void; label?: string };
}

export function Section({ title, children, reset }: SectionProps) {
  return (
    <section className="panel-section">
      <h3>
        <span>{title}</span>
        {reset?.visible && (
          <button type="button" className="section-reset" onClick={reset.onClick}>
            <Icon name="reset" /> {reset.label ?? "Redefinir"}
          </button>
        )}
      </h3>
      {children}
    </section>
  );
}

export function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle-row">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

const ICONS = {
  play: "M8 5v14l11-7z",
  pause: "M6 5h4v14H6zM14 5h4v14h-4z",
  playBack: "M16 5v14L5 12z",
  undo: "M12.5 8c-2.65 0-5.05 1-6.9 2.6L2 7v9h9l-3.62-3.62A7.94 7.94 0 0 1 12.5 10c3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 10.53 17.15 8 12.5 8z",
  redo: "M18.4 10.6A10.4 10.4 0 0 0 11.5 8c-4.65 0-8.58 2.53-9.97 6.72l2.37.78A8.01 8.01 0 0 1 11.5 10c1.95 0 3.73.72 5.12 1.88L13 15.5h9v-9z",
  split: "M11 2h2v20h-2zM4 7l5 5-5 5zM20 7l-5 5 5 5z",
  trash: "M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z",
  text: "M5 4v3h5.5v12h3V7H19V4z",
  plus: "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z",
  eye: "M12 5C7 5 2.73 8.11 1 12.5 2.73 16.89 7 20 12 20s9.27-3.11 11-7.5C21.27 8.11 17 5 12 5zm0 12.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  eyeOff: "M12 7a5 5 0 0 1 5 5c0 .65-.13 1.26-.36 1.83l2.92 2.92A11.82 11.82 0 0 0 23 12.5C21.27 8.11 17 5 12 5c-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46A11.8 11.8 0 0 0 1 12.5C2.73 16.89 7 20 12 20c1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3zM12 17.5a5 5 0 0 1-4.6-6.96l1.57 1.57a3 3 0 0 0 3.4 3.4l1.57 1.57c-.6.27-1.25.42-1.94.42z",
  volume: "M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06A9 9 0 0 0 14 3.23z",
  mute: "M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zM19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12a9 9 0 0 0-7-8.77v2.06A7 7 0 0 1 19 12zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9zM12 4 9.91 6.09 12 8.18z",
  lock: "M18 8h-1V6A5 5 0 0 0 7 6v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zm-6 9a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm3.1-9H8.9V6a3.1 3.1 0 0 1 6.2 0z",
  unlock: "M12 17a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm6-9h-1V6A5 5 0 0 0 7.1 5.1l1.9.6A3.1 3.1 0 0 1 15.1 6v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2z",
  zoomIn: "M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16a6.47 6.47 0 0 0 4.23-1.57l.27.28v.79l5 4.99L20.49 19zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14zM12 10h-2v2H9v-2H7V9h2V7h1v2h2z",
  film: "M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V4z",
  music: "M12 3v10.55A4 4 0 1 0 14 17V7h4V3z",
  image: "M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2zM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5z",
  export: "M19 12v7H5v-7H3v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7zm-6 .67 2.59-2.58L17 11.5l-5 5-5-5 1.41-1.41L11 12.67V3h2z",
  folder: "M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8z",
  save: "M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7zm-5 16a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm3-10H5V5h10z",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zm-1 7V3.5L18.5 9z",
  magic: "M7.5 5.6 10 7 8.6 4.5 10 2 7.5 3.4 5 2l1.4 2.5L5 7zm12 9.8L17 14l1.4 2.5L17 19l2.5-1.4L22 19l-1.4-2.5L22 14zM22 2l-2.5 1.4L17 2l1.4 2.5L17 7l2.5-1.4L22 7l-1.4-2.5zm-7.63 5.29a1 1 0 0 0-1.41 0L1.29 18.96a1 1 0 0 0 0 1.41l2.34 2.34a1 1 0 0 0 1.41 0L16.7 11.05a1 1 0 0 0 0-1.41zm-1.03 5.49-2.12-2.12 2.44-2.44 2.12 2.12z",
  transition: "M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5v2h2V1h-2zm0 15H5l5-6zm9-15h-5v2h5v13l-5-6v9h5a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z",
  captions: "M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1zm7 0h-1.5v-.5h-2v3h2V13H18v1a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1z",
  hd: "M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm-8 12H9.5v-2h-2v2H6V9h1.5v2.5h2V9H11zm2-6h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4zm1.5 4.5h2v-3h-2z",
  reverse: "M6 6h2v12H6zm3.5 6 8.5 6V6z",
  denoise: "M3 10v4h2v-4zm4-3v10h2V7zm4 4v2h2v-2zm4-6v14h2V5zm4 4v6h2V9z",
  cursor: "M7 2l12 11.2-5.8.5 3.3 7.3-2.2 1-3.2-7.4L7 18.5z",
  blade: "M9.64 7.64c.23-.5.36-1.05.36-1.64a4 4 0 1 0-4 4c.59 0 1.14-.13 1.64-.36L10 12l-2.36 2.36A3.92 3.92 0 0 0 6 14a4 4 0 1 0 4 4c0-.59-.13-1.14-.36-1.64L12 14l7 7h3v-1zM6 8a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm0 12a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm6-7.5a.5.5 0 1 1 0-1 .5.5 0 0 1 0 1zM19 3l-6 6 2 2 7-7V3z",
  deleteLeft: "M11 4h2v16h-2zM3 7h6v10H3zm11 0h7v10h-7zM4 11h4v2H4z",
  deleteRight: "M11 4h2v16h-2zM3 7h7v10H3zm12 0h6v10h-6zm1 4h4v2h-4z",
  freeze: "M22 11h-4.17l3.24-3.24-1.41-1.42L15 11h-2V9l4.66-4.66-1.42-1.41L13 6.17V2h-2v4.17L7.76 2.93 6.34 4.34 11 9v2H9L4.34 6.34 2.93 7.76 6.17 11H2v2h4.17l-3.24 3.24 1.41 1.42L9 13h2v2l-4.66 4.66 1.42 1.41L11 17.83V22h2v-4.17l3.24 3.24 1.42-1.41L13 15v-2h2l4.66 4.66 1.41-1.42L17.83 13H22z",
  mirror: "M15 21h2v-2h-2zm4-12h2V7h-2zM3 5v14a2 2 0 0 0 2 2h4v-2H5V5h4V3H5a2 2 0 0 0-2 2zm16-2v2h2a2 2 0 0 0-2-2zm-8 20h2V1h-2zm8-6h2v-2h-2zM15 5h2V3h-2zm4 8h2v-2h-2zm0 8a2 2 0 0 0 2-2h-2z",
  rotate: "M7.11 8.53 5.7 7.11C4.8 8.27 4.24 9.61 4.07 11h2.02c.14-.87.49-1.72 1.02-2.47zM6.09 13H4.07a7.98 7.98 0 0 0 1.62 3.89l1.41-1.42c-.52-.75-.87-1.59-1.01-2.47zm1.01 5.32A7.95 7.95 0 0 0 11 19.93V17.9a5.88 5.88 0 0 1-2.48-1.02zM13 4.07V1L8.45 5.55 13 10V6.09A6 6 0 0 1 18 12a6 6 0 0 1-5 5.91v2.02A8 8 0 0 0 20 12a8 8 0 0 0-7-7.93z",
  crop: "M17 15h2V7a2 2 0 0 0-2-2H9v2h8zM7 17V1H5v4H1v2h4v10a2 2 0 0 0 2 2h10v4h2v-4h4v-2z",
  mic: "M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5.3-3a5.3 5.3 0 0 1-10.6 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11z",
  gamepad: "M21 7H3a2 2 0 0 0-2 2v6a4 4 0 0 0 7.2 2.4L9.5 16h5l1.3 1.4A4 4 0 0 0 23 15V9a2 2 0 0 0-2-2zM10 12H8v2H6v-2H4v-2h2V8h2v2h2zm5.5 1a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3-2a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z",
  home: "M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z",
  search: "M15.5 14h-.79l-.28-.27A6.5 6.5 0 1 0 14 15.5l.27.28v.79l5 4.99L20.49 19zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z",
  memory: "M12 3a7 7 0 0 0-4 12.74V18a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.26A7 7 0 0 0 12 3zm-3 18h6v1a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1z",
  group: "M3 3h8v8H3zm2 2v4h4V5zm8-2h8v8h-8zm2 2v4h4V5zM3 13h8v8H3zm2 2v4h4v-4zm8-2h8v8h-8zm2 2v4h4v-4z",
  ungroup: "M3 3h6v6H3zm12 0h6v6h-6zM3 15h6v6H3zm12 0h6v6h-6zM10 10h4v4h-4z",
  copy: "M16 1H4a2 2 0 0 0-2 2v14h2V3h12zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11z",
  paste: "M19 2h-4.18A3 3 0 0 0 12 0a3 3 0 0 0-2.82 2H5a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm-7 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm7 18H5V4h2v3h10V4h2z",
  sparkle:"M11 3l2.3 6.2L19.5 11.5l-6.2 2.3L11 20l-2.3-6.2L2.5 11.5l6.2-2.3zM19 15l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1z",
  magnet: "M3 7v6a9 9 0 0 0 18 0V7h-5v6a4 4 0 0 1-8 0V7zm0-4h5v3H3zm13 0h5v3h-5z",
  snap: "M7 2h2v20H7zm8 0h2v20h-2zM3 11h18v2H3z",
  link: "M3.9 12a3.1 3.1 0 0 1 3.1-3.1h4V7H7a5 5 0 0 0 0 10h4v-1.9H7A3.1 3.1 0 0 1 3.9 12zM8 13h8v-2H8zm9-6h-4v1.9h4a3.1 3.1 0 0 1 0 6.2h-4V17h4a5 5 0 0 0 0-10z",
  previewAxis: "M11 2h2v20h-2zM3 6h6v12H3zm12 0h6v12h-6z",
  filter: "M12 3a9 9 0 1 0 0 18c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01a1.5 1.5 0 0 1 1.13-2.49H16a5 5 0 0 0 5-5c0-4.42-4.03-8-9-8zm-5.5 9a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3-4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3 4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z",
  adjust: "M3 17v2h6v-2zM3 5v2h10V5zm10 16v-2h8v-2h-8v-2h-2v6zM7 9v2H3v2h4v2h2V9zm14 4v-2H11v2zm-6-4h2V7h4V5h-4V3h-2z",
  template: "M3 3h8v8H3zm2 2v4h4V5zm8-2h8v5h-8zm0 7h8v11h-8zm-10 3h8v8H3z",
  sticker: "M12 2a10 10 0 1 0 10 10h-6a4 4 0 0 1-4-4V2zm2 .2V8a2 2 0 0 0 2 2h5.8A10 10 0 0 0 14 2.2zM8.5 9A1.5 1.5 0 1 1 8.5 12 1.5 1.5 0 0 1 8.5 9zm-1 5h9a4.5 4.5 0 0 1-9 0z",
  marker: "M17 3H7a2 2 0 0 0-2 2v16l7-3 7 3V5a2 2 0 0 0-2-2z",
  ripple: "M3 5h4v14H3zm7 0h4v14h-4zm7 0h4v14h-4zM8 11h1v2H8zm7 0h1v2h-1z",
  detach: "M3 4h10v7H3zm0 9h18v2H3zm0 4h18v2H3zm13-9 3-3 3 3h-2v4h-2V8z",
  keyboard: "M20 5H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm-9 3h2v2h-2zm0 3h2v2h-2zM8 8h2v2H8zm0 3h2v2H8zm-1 2H5v-2h2zm0-3H5V8h2zm9 7H8v-2h8zm0-4h-2v-2h2zm0-3h-2V8h2zm3 3h-2v-2h2zm0-3h-2V8h2z",
  person: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z",
  eraser: "M16.24 3.56 21.19 8.5a2 2 0 0 1 0 2.83L12 20.53H6.41l-3.6-3.6a2 2 0 0 1 0-2.83L13.41 3.56a2 2 0 0 1 2.83 0zM4.22 15.5l3.03 3.03h3.92l1.24-1.24-4.95-4.95z",
  reset: "M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z",
  close: "M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
  edit: "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z",
} as const;

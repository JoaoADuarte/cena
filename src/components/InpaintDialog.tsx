import { useEffect, useRef, useState } from "react";
import type { Material } from "../model/types";
import { mediaUrl } from "../engine/mediaPool";
import { aiErrorMessage, runAiTask, useAiJob } from "../ai";
import { SliderRow } from "./controls";

const MAX_W = 860;
const MAX_H = 540;

/**
 * Paint over objects in a photo and erase them with LaMa. Each removal produces a new PNG, so
 * removals can be stacked and undone; nothing touches the project until "Aplicar".
 */
export function InpaintDialog({ material, onClose, onApply }: { material: Material; onClose: () => void; onApply: (path: string) => void }) {
  const [current, setCurrent] = useState(material.path);
  const [history, setHistory] = useState<string[]>([]);
  const [brush, setBrush] = useState(36);
  const [display, setDisplay] = useState<{ w: number; h: number; naturalW: number; naturalH: number } | null>(null);
  const [painted, setPainted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useAiJob((s) => s.job !== null);
  const view = useRef<HTMLCanvasElement>(null);
  const image = useRef<HTMLImageElement | null>(null);
  // Strokes are kept twice: white on black at the photo's resolution for the model, and a red overlay at screen size.
  const mask = useRef<HTMLCanvasElement>(document.createElement("canvas"));
  const overlay = useRef<HTMLCanvasElement>(document.createElement("canvas"));
  const last = useRef<{ x: number; y: number } | null>(null);

  const redraw = () => {
    const canvas = view.current;
    if (!canvas || !image.current || !display) return;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image.current, 0, 0, display.w, display.h);
    ctx.globalAlpha = 0.55;
    ctx.drawImage(overlay.current, 0, 0);
    ctx.globalAlpha = 1;
  };

  const clearMask = () => {
    const m = mask.current.getContext("2d")!;
    m.fillStyle = "#000";
    m.fillRect(0, 0, mask.current.width, mask.current.height);
    overlay.current.getContext("2d")!.clearRect(0, 0, overlay.current.width, overlay.current.height);
    setPainted(false);
    redraw();
  };

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, MAX_W / img.naturalWidth, MAX_H / img.naturalHeight);
      const d = { w: Math.round(img.naturalWidth * k), h: Math.round(img.naturalHeight * k), naturalW: img.naturalWidth, naturalH: img.naturalHeight };
      image.current = img;
      mask.current.width = d.naturalW;
      mask.current.height = d.naturalH;
      overlay.current.width = d.w;
      overlay.current.height = d.h;
      clearMask();
      setDisplay(d);
    };
    img.onerror = () => setError("Não foi possível abrir a imagem.");
    img.src = mediaUrl(current);
  }, [current]);

  useEffect(redraw, [display]);

  const stroke = (x: number, y: number) => {
    if (!display) return;
    const k = display.naturalW / display.w;
    const from = last.current ?? { x, y };
    for (const [c, scale, color] of [
      [overlay.current, 1, "#ff3b4e"],
      [mask.current, k, "#fff"],
    ] as const) {
      const ctx = c.getContext("2d")!;
      ctx.strokeStyle = color;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = brush * scale;
      ctx.beginPath();
      ctx.moveTo(from.x * scale, from.y * scale);
      ctx.lineTo(x * scale + 0.01, y * scale);
      ctx.stroke();
    }
    last.current = { x, y };
    setPainted(true);
    redraw();
  };

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const erase = async () => {
    setError(null);
    try {
      const maskPng = mask.current.toDataURL("image/png").split(",")[1];
      const res = await runAiTask("Remover objetos", "removeObjects", { path: current, maskPng });
      setHistory((h) => [...h, current]);
      setCurrent(res.path);
    } catch (err) {
      setError(aiErrorMessage(err));
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal inpaint-modal">
        <h2>Remover objetos</h2>
        <p className="modal-note">Pinte por cima do que deseja apagar e clique em "Remover". Pode repetir quantas vezes quiser antes de aplicar.</p>
        <div className="inpaint-stage" style={{ width: display?.w ?? MAX_W, height: display?.h ?? 300 }}>
          {display ? (
            <canvas
              ref={view}
              width={display.w}
              height={display.h}
              style={{ cursor: busy ? "progress" : "crosshair" }}
              onPointerDown={(e) => {
                if (busy) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                last.current = null;
                const p = pos(e);
                stroke(p.x, p.y);
              }}
              onPointerMove={(e) => {
                if (busy || !(e.buttons & 1)) return;
                const p = pos(e);
                stroke(p.x, p.y);
              }}
              onPointerUp={() => (last.current = null)}
            />
          ) : (
            <span className="empty-hint">{error ?? "Carregando…"}</span>
          )}
        </div>
        <SliderRow label="Pincel" min={6} max={120} step={1} unit="px" value={brush} onChange={(v) => setBrush(v)} />
        {error && display && <p className="error-text">{error}</p>}
        <div className="modal-actions">
          <button disabled={busy || !painted} onClick={clearMask}>
            Limpar seleção
          </button>
          <button
            disabled={busy || history.length === 0}
            onClick={() => {
              setCurrent(history[history.length - 1]);
              setHistory((h) => h.slice(0, -1));
            }}
          >
            Desfazer remoção
          </button>
          <span className="spacer" />
          <button onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button disabled={busy || !painted} onClick={() => void erase()}>
            Remover
          </button>
          <button className="primary" disabled={busy || current === material.path} onClick={() => onApply(current)}>
            Aplicar ao clipe
          </button>
        </div>
      </div>
    </div>
  );
}

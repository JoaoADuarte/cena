import { useEffect, useRef } from "react";
import { create } from "zustand";
import { useEditor } from "../store";
import { shortTime } from "../model/time";
import type { Micros } from "../model/types";
import { Icon } from "./controls";

export const MARKER_COLORS = ["#ffd400", "#ff5a4f", "#22c3b5", "#4f8bff", "#c46bff"];

/** The markers list: open or closed, which marker is being edited, and the button it hangs from. */
export const useMarkerPanel = create<{ open: boolean; editing: string | null; anchor: DOMRect | null; set: (patch: Partial<{ open: boolean; editing: string | null; anchor: DOMRect | null }>) => void }>((set) => ({
  open: false,
  editing: null,
  anchor: null,
  set: (patch) => set(patch),
}));

/** Opens the list from `button` (or where it already hangs), editing `editing` when given. */
export function openMarkers(button: HTMLElement | null, editing: string | null = null) {
  const panel = useMarkerPanel.getState();
  panel.set({ open: true, editing, anchor: button?.getBoundingClientRect() ?? panel.anchor });
}

/** A marker at the playhead, opened for its name and the reason to come back. */
export function addMarkerHere(button: HTMLElement | null) {
  const s = useEditor.getState();
  const existing = s.project.markers.find((m) => Math.abs(m.time - s.playhead) < 1000);
  const id = existing?.id ?? s.addMarker(s.playhead);
  openMarkers(button, id);
}

/**
 * Every marker of the project, in time order: click to go there, name it, write why it is there and pick a color.
 * Marks a moment to come back to; the export ignores them.
 */
export function MarkersPanel() {
  const { open, editing, anchor, set } = useMarkerPanel();
  const markers = useEditor((s) => s.project.markers);
  const playhead = useEditor((s) => s.playhead);
  const { setPlayhead, updateMarker, removeMarker, checkpoint } = useEditor.getState();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (box.current?.contains(target) || target.closest("[data-markers-button], .marker-flag")) return;
      set({ open: false, editing: null });
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && set({ open: false, editing: null });
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", key);
    };
  }, [open, set]);

  if (!open) return null;
  const width = 340;
  const left = Math.max(8, Math.min((anchor?.left ?? 200) - 40, window.innerWidth - width - 8));
  const bottom = anchor ? window.innerHeight - anchor.top + 6 : 120;
  const near = (t: Micros) => Math.abs(t - playhead) < 1000;

  return (
    <div className="markers-panel" ref={box} style={{ left, bottom, width }} onKeyDown={(e) => e.stopPropagation()}>
      <div className="markers-head">
        <b>Marcadores</b>
        <span className="grow" />
        <button
          title="Marcador anterior (Shift+M)"
          disabled={!markers.some((m) => m.time < playhead - 1000)}
          onClick={() => {
            const m = [...markers].reverse().find((x) => x.time < playhead - 1000);
            if (m) setPlayhead(m.time);
          }}
        >
          ◀
        </button>
        <button
          title="Próximo marcador (Alt+M)"
          disabled={!markers.some((m) => m.time > playhead + 1000)}
          onClick={() => {
            const m = markers.find((x) => x.time > playhead + 1000);
            if (m) setPlayhead(m.time);
          }}
        >
          ▶
        </button>
        <button title="Marcar o ponto do cursor" onClick={() => addMarkerHere(null)}>
          <Icon name="plus" /> Marcar aqui
        </button>
      </div>
      {!markers.length && <p className="hint">Nenhum marcador. Ponha o cursor no ponto que quer lembrar e clique em "Marcar aqui" (ou tecle M).</p>}
      <ul>
        {markers.map((m) => (
          <li key={m.id} className={`${near(m.time) ? "here" : ""}${editing === m.id ? " editing" : ""}`}>
            <div className="marker-row" onClick={() => (setPlayhead(m.time), set({ editing: editing === m.id ? editing : null }))} title="Ir até este ponto">
              <i style={{ background: m.color }} />
              <span className="marker-time">{shortTime(m.time)}</span>
              <span className="marker-name">
                {m.label}
                {m.note ? <small>{m.note}</small> : null}
              </span>
              <button
                title="Editar"
                onClick={(e) => {
                  e.stopPropagation();
                  set({ editing: editing === m.id ? null : m.id });
                }}
              >
                ✎
              </button>
              <button
                className="marker-del"
                title="Apagar marcador"
                onClick={(e) => {
                  e.stopPropagation();
                  removeMarker(m.id);
                }}
              >
                <Icon name="close" />
              </button>
            </div>
            {editing === m.id && (
              <div className="marker-edit">
                {/* Typing is one undo step per field, not one per letter. */}
                <input autoFocus value={m.label} placeholder="Nome" onChange={(e) => updateMarker(m.id, { label: e.target.value }, { history: false })} onFocus={(e) => (checkpoint(), e.target.select())} />
                <textarea value={m.note ?? ""} placeholder="Por que marcou? Ex.: trocar a música aqui, conferir legenda…" rows={2} onChange={(e) => updateMarker(m.id, { note: e.target.value }, { history: false })} onFocus={() => checkpoint()} />
                <div className="marker-colors">
                  {MARKER_COLORS.map((c) => (
                    <button key={c} className={c === m.color ? "on" : ""} style={{ background: c }} title="Cor" onClick={() => updateMarker(m.id, { color: c })} />
                  ))}
                  <span className="grow" />
                  <button onClick={() => set({ editing: null })}>Pronto</button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

import { useEffect, useState } from "react";
import { ACTIONS, comboLabel, comboOf, keysFor, useShortcuts } from "../shortcuts";

/** Lists every action with its keys; "Alterar" records the next key combination. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  useShortcuts((s) => s.overrides); // re-render on change
  const { set, resetAll } = useShortcuts.getState();
  const [recording, setRecording] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      const combo = comboOf(e);
      if (!combo) return;
      const other = ACTIONS.find((a) => a.id !== recording && keysFor(a.id).includes(combo));
      if (other) {
        // Move the key over: the other action loses it.
        set(other.id, keysFor(other.id).filter((k) => k !== combo));
        setConflict(`${comboLabel(combo)} saiu de "${other.label}".`);
      } else setConflict(null);
      set(recording, [combo]);
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, set]);

  const groups = [...new Set(ACTIONS.map((a) => a.group))];
  return (
    <div className="modal-backdrop">
      <div className="modal shortcuts-modal">
        <h2>Atalhos de teclado</h2>
        {conflict && <p className="hint">{conflict}</p>}
        <div className="shortcuts-list">
          {groups.map((g) => (
            <div key={g}>
              <h4 className="lib-group">{g}</h4>
              {ACTIONS.filter((a) => a.group === g).map((a) => {
                const keys = keysFor(a.id);
                const custom = Boolean(useShortcuts.getState().overrides[a.id]);
                return (
                  <div key={a.id} className="shortcut-row">
                    <span>{a.label}</span>
                    <span className="shortcut-keys">
                      {recording === a.id ? <kbd className="recording">Pressione as teclas…</kbd> : keys.length ? keys.map((k) => <kbd key={k}>{comboLabel(k)}</kbd>) : <em>sem atalho</em>}
                    </span>
                    <button onClick={() => setRecording(recording === a.id ? null : a.id)}>{recording === a.id ? "Cancelar" : "Alterar"}</button>
                    <button disabled={!custom} title="Voltar à tecla padrão" onClick={() => set(a.id, null)}>
                      Padrão
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button onClick={resetAll}>Restaurar todos</button>
          <span className="spacer" />
          <button className="primary" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}

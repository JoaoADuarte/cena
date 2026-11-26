import { useEffect, useRef, useState } from "react";
import { useEditor } from "../store";
import { mediaUrl } from "../engine/mediaPool";
import { addNarration, narratedHook } from "../narration";
import { timecode } from "../model/time";

const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/**
 * "Voz de IA": the creator writes a sentence, listens to it, and puts it in as a narration or as a narrated hook
 * (the voice over pieces of the video, then the real moment).
 */
export function AiVoiceDialog({ onClose }: { onClose: () => void }) {
  const fps = useEditor((s) => s.project.fps);
  const playhead = useEditor((s) => s.playhead);
  const [ready, setReady] = useState<boolean | null>(null);
  const [install, setInstall] = useState<{ progress: number; text: string } | null>(null);
  const [text, setText] = useState("");
  const [speed, setSpeed] = useState(1);
  const [mode, setMode] = useState<"hook" | "voice">("hook");
  const [where, setWhere] = useState<"start" | "playhead">("start");
  const [slow, setSlow] = useState(0.6);
  const [captions, setCaptions] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    void window.api.ttsStatus().then((s) => setReady(s.installed));
    return window.api.onTtsProgress((p) => setInstall(p));
  }, []);

  const download = async () => {
    setError(null);
    setInstall({ progress: 0, text: "Começando" });
    try {
      const s = await window.api.ttsInstall();
      setReady(s.installed);
    } catch (e) {
      setError(clean(e));
    } finally {
      setInstall(null);
    }
  };
  const listen = async () => {
    setError(null);
    setBusy("Gerando a voz…");
    try {
      const file = await window.api.ttsSpeak(text, { speed });
      if (audio.current) {
        audio.current.src = mediaUrl(file);
        await audio.current.play();
      }
    } catch (e) {
      setError(clean(e));
    } finally {
      setBusy(null);
    }
  };
  const apply = async () => {
    setError(null);
    setBusy(mode === "hook" ? "Montando o gancho…" : "Colocando a voz…");
    try {
      if (mode === "hook") await narratedHook(text, { at: where === "start" ? 0 : playhead, speed, teaserSpeed: slow, captions });
      else await addNarration(text, { start: playhead, speed, captions });
      onClose();
    } catch (e) {
      setError(clean(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal ai-voice">
        <h2>Voz de IA</h2>
        {ready === false && (
          <>
            <p className="modal-note">
              A voz de IA roda no seu PC, sem internet depois de baixada e sem custo. Ela precisa ser baixada uma vez (cerca de 85 MB, das páginas oficiais do Piper).
            </p>
            {install ? (
              <>
                <div className="mic-meter">
                  <div style={{ width: `${Math.round(install.progress * 100)}%` }} />
                </div>
                <p className="modal-note">
                  {install.text} · {Math.round(install.progress * 100)}%
                </p>
              </>
            ) : (
              <div className="modal-actions">
                <button onClick={onClose}>Cancelar</button>
                <button className="primary" onClick={() => void download()}>
                  Baixar voz de IA
                </button>
              </div>
            )}
          </>
        )}
        {ready && (
          <>
            <label className="field">
              <span>O que a voz fala</span>
              <textarea rows={3} value={text} disabled={Boolean(busy)} onChange={(e) => setText(e.target.value)} placeholder='Ex.: "Olha o que aconteceu quando eu encontrei um transatlântico."' autoFocus />
            </label>
            <label className="field">
              <span>Velocidade da fala: {speed.toFixed(2)}×</span>
              <input type="range" min={0.7} max={1.5} step={0.05} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
            </label>
            <div className="ai-voice-modes">
              <label className="toggle-row">
                <input type="radio" checked={mode === "hook"} onChange={() => setMode("hook")} />
                <span>
                  <b>Gancho narrado</b>: enquanto a voz fala, o vídeo roda de fundo como prévia (mais lento, sem som); depois vem o momento de verdade.
                </span>
              </label>
              <label className="toggle-row">
                <input type="radio" checked={mode === "voice"} onChange={() => setMode("voice")} />
                <span>
                  <b>Só a voz</b>, na agulha ({timecode(playhead, fps)}), por cima do que já está lá.
                </span>
              </label>
            </div>
            {mode === "hook" && (
              <>
                <label className="field">
                  <span>Onde entra o gancho</span>
                  <select value={where} onChange={(e) => setWhere(e.target.value as "start" | "playhead")}>
                    <option value="start">No começo do vídeo</option>
                    <option value="playhead">Na agulha ({timecode(playhead, fps)}): o que vem depois é o momento mostrado</option>
                  </select>
                </label>
                <label className="field">
                  <span>Velocidade da prévia de fundo: {slow.toFixed(2)}×</span>
                  <input type="range" min={0.3} max={1} step={0.05} value={slow} onChange={(e) => setSlow(Number(e.target.value))} />
                </label>
              </>
            )}
            <label className="toggle-row">
              <input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} />
              <span>Mostrar a frase na tela enquanto a voz fala</span>
            </label>
            {busy && <p className="modal-note">{busy}</p>}
            <div className="modal-actions">
              <button onClick={onClose} disabled={Boolean(busy)}>
                Cancelar
              </button>
              <button disabled={!text.trim() || Boolean(busy)} onClick={() => void listen()}>
                Ouvir
              </button>
              <button className="primary" disabled={!text.trim() || Boolean(busy)} onClick={() => void apply()}>
                {mode === "hook" ? "Fazer o gancho" : "Colocar a voz"}
              </button>
            </div>
            <p className="modal-note">Tudo vira clipes normais na linha do tempo: dá para mexer depois ou desfazer com Ctrl+Z.</p>
          </>
        )}
        {ready === null && <p className="modal-note">Verificando a voz…</p>}
        {error && <p className="error-text">{error}</p>}
        <audio ref={audio} hidden />
      </div>
    </div>
  );
}


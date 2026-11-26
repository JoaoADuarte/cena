import { useState } from "react";
import { useEditor } from "../store";
import { aiErrorMessage, runAiTask } from "../ai";
import { audioPlan } from "../engine/exporter";
import { projectDuration } from "../model/project";
import { splitCaptions } from "../model/captions";

const LANGUAGES = [
  { value: "pt", label: "Português" },
  { value: "en", label: "Inglês" },
  { value: "es", label: "Espanhol" },
  { value: "", label: "Detectar automaticamente" },
];

/** Options for automatic captions; the transcription itself runs in the background with top-bar progress. */
export function CaptionsDialog({ onClose }: { onClose: () => void }) {
  const project = useEditor((s) => s.project);
  const [language, setLanguage] = useState("pt");
  const [quality, setQuality] = useState<"fast" | "accurate" | "max">("accurate");
  const [maxWords, setMaxWords] = useState(6);
  const hasCaptions = project.tracks.some((t) => t.role === "captions");
  const [replace, setReplace] = useState(true);
  const audio = audioPlan(project);

  const start = async () => {
    onClose();
    const { setStatus, addCaptions, setPlaying } = useEditor.getState();
    setPlaying(false);
    try {
      const { segments } = await runAiTask("Legendas automáticas", "transcribe", {
        audio,
        duration: projectDuration(project),
        language: language || null,
        quality,
      });
      const count = addCaptions(splitCaptions(segments, maxWords), replace && hasCaptions);
      setStatus(count ? `${count} legendas criadas na faixa "Legendas".` : "Nenhuma fala foi reconhecida no áudio.");
    } catch (err) {
      const message = aiErrorMessage(err);
      setStatus(message ? `Falha nas legendas: ${message}` : "Legendas canceladas.");
    }
    setTimeout(() => useEditor.getState().setStatus(null), 6000);
  };

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>Legendas automáticas</h2>
        <p className="modal-note">
          O Cena ouve o áudio da timeline e cria uma legenda para cada trecho de fala. Tudo roda neste computador com o Whisper; o
          modelo é baixado só na primeira vez.
        </p>
        <label className="field">
          <span>Idioma falado</span>
          <select value={language} onChange={(e) => setLanguage(e.target.value)}>
            {LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Qualidade</span>
          <select value={quality} onChange={(e) => setQuality(e.target.value as "fast" | "accurate" | "max")}>
            <option value="accurate">Precisa (download de ~500 MB)</option>
            <option value="fast">Rápida (download de ~140 MB)</option>
            <option value="max">Máxima — large-v3-turbo (download de ~1 GB, mais lenta)</option>
          </select>
        </label>
        <label className="field">
          <span>Palavras por legenda (máximo)</span>
          <select value={maxWords} onChange={(e) => setMaxWords(Number(e.target.value))}>
            {[3, 4, 5, 6, 8, 10, 14].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        {hasCaptions && (
          <label className="toggle-row">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
            <span>Substituir as legendas automáticas existentes</span>
          </label>
        )}
        {audio.length === 0 && <p className="error-text">A timeline não tem nenhum clipe com áudio.</p>}
        <div className="modal-actions">
          <button onClick={onClose}>Cancelar</button>
          <button className="primary" disabled={audio.length === 0} onClick={start}>
            Gerar legendas
          </button>
        </div>
      </div>
    </div>
  );
}

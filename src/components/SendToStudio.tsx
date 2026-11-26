import { useEffect, useState } from "react";
import { useEditor } from "../store";
import { ALL_AGENTS, AgentsPicker, BRIEF_EXAMPLES, STOPS, withExample } from "../studio/flow";

const message = (err: unknown) => String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/**
 * Sends the project open in the editor to the studio: its recording and the cuts made here, with how the creator
 * wants it edited and which agents should work on it. The project itself is kept as it is.
 */
export function SendToStudioDialog({ onClose }: { onClose: () => void }) {
  const project = useEditor((s) => s.project);
  const projectPath = useEditor((s) => s.projectPath);
  const [text, setText] = useState("");
  const [stops, setStops] = useState<string[]>([]);
  const [agents, setAgents] = useState<string[]>(ALL_AGENTS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The main track does not simply follow one recording: the studio can make a new one in the editor's order. */
  const [canOrder, setCanOrder] = useState(false);
  /** A video the creator already exported here: it becomes the video as it is (no cutting, no render). */
  const [exported, setExported] = useState<string | null>(null);
  // Only the title, description and thumbnails asked for: the studio can work on a file already exported.
  const onlyPackaging = agents.length > 0 && agents.every((a) => a === "metadata" || a === "thumbnail");

  // The usual request from the studio's settings, when there is one.
  useEffect(() => {
    void window.api
      .studioCall("state")
      .then((s: { settings?: { flow?: { brief?: string; stops?: string[] } } }) => {
        if (s?.settings?.flow?.brief) setText((t) => t || s.settings!.flow!.brief!);
        if (s?.settings?.flow?.stops?.length) setStops(s.settings.flow.stops);
      })
      .catch(() => {});
  }, []);

  const send = async (order = false) => {
    setBusy(true);
    setError(null);
    try {
      if (!(await window.api.studioAvailable())) throw new Error("O Estúdio não está disponível nesta janela do Cena (há outro Cena aberto com ele).");
      await window.api.studioCall("sendFromEditor", { project, projectPath, brief: { text: text.trim(), stops, agents }, order, exported: onlyPackaging ? exported : null });
      await window.api.openStudio();
      onClose();
    } catch (err) {
      const said = message(err);
      setError(said);
      setCanOrder(!order && /não segue a gravação em ordem|junta \d+ gravações|velocidade/.test(said));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal send-studio-modal">
        <h2>Enviar ao Estúdio</h2>
        <p className="modal-note">A gravação e os cortes deste projeto vão para os agentes. O seu projeto fica como está.</p>
        <label className="send-field">
          <span>Como você quer a edição?</span>
          <textarea rows={5} autoFocus value={text} placeholder="Ex.: serão 4 vídeos, cada um com 2 corridas; música animada, legendas grandes, ritmo rápido." onChange={(e) => setText(e.target.value)} />
        </label>
        <div className="send-examples">
          {BRIEF_EXAMPLES.map((example) => (
            <button key={example} onClick={() => setText((t) => withExample(t, example))}>
              + {example}
            </button>
          ))}
        </div>
        <h4>Quais agentes trabalham</h4>
        <AgentsPicker value={agents} onChange={setAgents} fromEditor />
        {onlyPackaging && (
          <div className="send-final">
            <h4>Vídeo final</h4>
            <label className="toggle-row">
              <input type="radio" checked={!exported} onChange={() => setExported(null)} />
              <span>O Estúdio transcreve a gravação e renderiza este projeto (mais demorado)</span>
            </label>
            <label className="toggle-row">
              <input
                type="radio"
                checked={Boolean(exported)}
                onChange={() =>
                  void window.api
                    .studioCall("pickVideos")
                    .then((files: string[]) => files?.[0] && setExported(files[0]))
                    .catch(() => {})
                }
              />
              <span>Já exportei o vídeo: os agentes só escutam o arquivo exportado para o título, a descrição e as thumbnails. Nada é cortado nem renderizado (o mais rápido).</span>
            </label>
            {exported && (
              <p className="send-file">
                {exported}{" "}
                <button onClick={() => void window.api.studioCall("pickVideos").then((files: string[]) => files?.[0] && setExported(files[0]))}>Trocar</button>
              </p>
            )}
          </div>
        )}
        <h4>Onde o fluxo para e espera você</h4>
        {STOPS.map((stop) => (
          <label key={stop.id} className="toggle-row">
            <input type="checkbox" checked={stops.includes(stop.id)} onChange={(e) => setStops((list) => (e.target.checked ? [...list, stop.id] : list.filter((s) => s !== stop.id)))} />
            <span>{stop.label}</span>
          </label>
        ))}
        {error && <p className="send-error">{error}</p>}
        {canOrder && (
          <div className="send-order">
            <p>
              <b>Quer manter a ordem que você montou?</b> O Estúdio cria um arquivo novo com a faixa principal exatamente nessa ordem (trechos repetidos, movidos, acelerados ou de outras gravações), com cada faixa de som separada, e os agentes trabalham em cima dele. As suas gravações não são mexidas. Leva um tempo antes de os agentes começarem (num vídeo de 2 horas, uns 18 minutos) e ocupa espaço em disco (perto de 11 GB por hora de vídeo, apagado junto com o vídeo).
            </p>
            <button className="primary" disabled={busy} onClick={() => void send(true)}>
              {busy ? "Enviando…" : "Enviar na ordem do editor"}
            </button>
          </div>
        )}
        <div className="modal-actions">
          <button onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <span className="spacer" />
          <button className="primary" disabled={busy} onClick={() => void send(false)}>
            {busy ? "Enviando…" : "Enviar"}
          </button>
        </div>
      </div>
    </div>
  );
}

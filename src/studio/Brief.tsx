import { useState } from "react";
import { act, useStudio, type StudioVideo } from "./store";
import { ALL_AGENTS, AgentsPicker, BRIEF_EXAMPLES, STOPS, withExample } from "./flow";

export { STOPS };

const base = (file: string) => file.split(/[\\/]/).pop() ?? file;

/**
 * How the creator wants a video edited, said before the agents start (or changed later).
 * `files`: recordings about to enter the studio. `video`: one that is already in it.
 */
export function BriefDialog({ files, video, onClose }: { files?: string[]; video?: StudioVideo; onClose: () => void }) {
  const flow = useStudio((s) => s.state!.settings.flow);
  const claude = useStudio((s) => s.state!.claude);
  const start = video?.data.brief ?? { text: flow.brief, stops: flow.stops };
  const [text, setText] = useState(start.text ?? "");
  const [stops, setStops] = useState<string[]>(start.stops ?? []);
  const [agents, setAgents] = useState<string[]>(video ? (video.data.agents ?? ALL_AGENTS) : (flow.agents ?? ALL_AGENTS));
  const [keep, setKeep] = useState(false);
  const ingested = video?.stages.find((s) => s.name === "ingest")?.status === "done";
  const brief = { text: text.trim(), stops, agents };

  const begin = () => {
    if (keep) void act("setSettings", { flow: { brief: brief.text, stops: brief.stops, agents: brief.agents } });
    void act("addVideos", files, null, brief);
    onClose();
  };
  const save = (redoFrom: string | null) => {
    if (redoFrom && !confirm("Refazer a partir do Corte? Os cortes, a edição e a montagem deste vídeo são feitos de novo com o pedido. A transcrição é aproveitada.")) return;
    void act("setBrief", video!.id, brief, redoFrom);
    onClose();
  };

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h3>{video ? `Pedido para "${video.title}"` : files!.length > 1 ? `${files!.length} vídeos novos` : "Vídeo novo"}</h3>
        {files && <p className="studio-hint">{files.map(base).join(" · ")}</p>}
        <label className="field">
          <span>Como você quer a edição? (opcional)</span>
          <textarea rows={5} autoFocus value={text} placeholder="Escreva como se estivesse explicando para um editor. Ex.: serão 4 vídeos, cada um com 2 corridas; música animada, legendas grandes; corta a parte em que eu fico no menu." onChange={(e) => setText(e.target.value)} />
        </label>
        <div className="brief-examples">
          {BRIEF_EXAMPLES.map((example) => (
            <button key={example} onClick={() => setText((t) => withExample(t, example))}>
              + {example}
            </button>
          ))}
        </div>
        {!claude && <p className="card-error">Sem o Claude Code o pedido não é lido. As paradas e a escolha dos agentes funcionam mesmo assim.</p>}
        {video?.data.brief?.notes && <p className="studio-hint">Como o Estúdio entendeu: {video.data.brief.notes}</p>}
        <h4>Quais agentes trabalham</h4>
        <AgentsPicker value={agents} onChange={setAgents} fromEditor={Boolean(video?.data.fromEditor)} />
        <h4>Onde o fluxo para e espera você</h4>
        {STOPS.map((stop) => (
          <label key={stop.id} className="toggle-row">
            <input type="checkbox" checked={stops.includes(stop.id)} onChange={(e) => setStops((list) => (e.target.checked ? [...list, stop.id] : list.filter((s) => s !== stop.id)))} />
            <span>{stop.label}</span>
          </label>
        ))}
        <p className="studio-hint">Sem nenhuma parada o vídeo vai direto até "Aguardando aprovação". Se o pedido for para dividir a gravação em vários vídeos, o fluxo sempre para e mostra as partes antes de criá-los.</p>
        {files && (
          <label className="toggle-row">
            <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
            <span>Usar este pedido, estes agentes e estas paradas como padrão para os próximos vídeos</span>
          </label>
        )}
        <div className="modal-actions">
          <button onClick={onClose}>Cancelar</button>
          <span className="grow" />
          {files && (
            <button className="primary" onClick={begin}>
              Começar
            </button>
          )}
          {video && (
            <>
              {ingested && (
                <button onClick={() => save("cut")} title="Os agentes trabalham de novo, a partir do Corte, com este pedido">
                  Salvar e refazer a partir do Corte
                </button>
              )}
              <button className="primary" onClick={() => save(null)} title="Vale para as etapas que ainda não rodaram">
                Salvar
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

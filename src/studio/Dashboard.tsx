import { useState } from "react";
import { Icon } from "../components/controls";
import { mediaUrl } from "../engine/mediaPool";
import { BriefDialog } from "./Brief";
import { hasCuts } from "./Cuts";
import { Logs } from "./Logs";
import { ReleasePlan } from "./ReleasePlan";
import { act, clock, useStudio, type StudioVideo } from "./store";

const STATUS_LABEL: Record<StudioVideo["status"], string> = {
  queued: "Na fila",
  running: "Rodando",
  paused: "Pausado",
  hold: "Esperando você",
  review: "Aguardando você",
  approved: "Aprovado",
  rejected: "Rejeitado",
  error: "Erro",
  divided: "Dividido em vídeos",
};

function Meter({ label, value, detail }: { label: string; value: number; detail?: string }) {
  return (
    <div className="meter" title={detail}>
      <span>{label}</span>
      <div className="meter-bar">
        <div style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
      <b>{Math.round(value)}%</b>
    </div>
  );
}

function VideoCard({ video, onReview, onCuts, onBrief }: { video: StudioVideo; onReview: (id: number) => void; onCuts: (id: number) => void; onBrief: (video: StudioVideo) => void }) {
  const stages = useStudio((s) => s.state!.stages);
  const heldAfter = video.status === "hold" ? (stages.find((s) => s.name === video.data.hold?.after)?.label ?? "") : "";
  const current = video.stages.find((s) => s.status === "running") ?? video.stages.find((s) => s.status === "error");
  const working = video.status === "running" || video.status === "queued";
  return (
    <article className={`video-card status-${video.status}`}>
      <div className="video-card-head">
        {video.data.thumb ? <img src={mediaUrl(video.data.thumb)} alt="" /> : <div className="thumb-empty" />}
        <div>
          <h4 title={video.source_path}>{video.title}</h4>
          <small>
            {video.data.youtube ? (video.data.youtube.publishAt && video.data.youtube.publishAt > Date.now() ? "Agendado no YouTube" : "No YouTube") : video.data.publish && ["queued", "uploading", "waiting"].includes(video.data.publish.status) ? `Enviando ${Math.round((video.data.publish.progress ?? 0) * 100)}%` : STATUS_LABEL[video.status]}
            {video.data.duration ? ` · ${clock(video.data.duration)}` : ""}
            {video.priority ? ` · prioridade ${video.priority}` : ""}
          </small>
        </div>
      </div>
      {current?.status === "running" && (
        <div className="card-progress">
          <div className="progress-bar">
            <div style={{ width: `${Math.round(current.progress * 100)}%` }} />
          </div>
          <small>{current.message ?? "Trabalhando"}</small>
        </div>
      )}
      {video.error && <p className="card-error">{video.error}</p>}
      {video.status === "hold" && video.data.hold?.after === "split" && <p className="card-hold">O Diretor propôs {video.data.parts?.length ?? 0} vídeos. Confira as partes.</p>}
      {video.status === "hold" && video.data.hold?.after !== "split" && <p className="card-hold">Parado depois de {heldAfter}, como você pediu.</p>}
      {video.status === "divided" && <p className="card-hold">Virou {video.data.children?.length ?? 0} vídeos, que seguem no Painel.</p>}
      {video.data.partOf && (
        <p className="card-brief">
          Parte {video.data.partOf.index} de {video.data.partOf.count} · {clock(video.data.partOf.start)}–{clock(video.data.partOf.end)} da gravação
        </p>
      )}
      {Array.isArray(video.data.agents) && !video.data.agents.includes("cut") && ["pending", "running"].includes(video.stages.find((s) => s.name === "cut")?.status ?? "") && (
        <p className="card-hold" title="Os Metadados (título, descrição, capítulos) e a Thumbnail precisam saber o que é falado no vídeo. Nada é cortado: os cortes ficam como você deixou.">
          Só transcreve a fala para os Metadados e a Thumbnail. Nada é cortado.
        </p>
      )}
      {video.data.fromEditor && <p className="card-brief">Veio do editor{video.data.agents ? ` · agentes: ${video.data.agents.length}` : ""}</p>}
      {video.data.brief?.text && (
        <p className="card-brief" title={`${video.data.brief.text}${video.data.brief.notes ? `\n\nComo o Estúdio entendeu: ${video.data.brief.notes}` : ""}`}>
          Pedido: {video.data.brief.text}
        </p>
      )}
      <div className="card-actions">
        {video.status === "hold" && video.data.hold?.after === "split" && (
          <button className="primary" onClick={() => onCuts(video.id)} title="Ver, mudar e criar os vídeos desta gravação">
            Ver as partes
          </button>
        )}
        {video.status === "hold" && video.data.hold?.after !== "split" && (
          <button className="primary" onClick={() => void act("continueVideo", video.id)} title="Segue o fluxo com os cortes como estão">
            Continuar
          </button>
        )}
        {hasCuts(video) && !video.data.youtube && (
          <button className={video.status === "hold" ? "primary" : ""} onClick={() => onCuts(video.id)} title="Ver e mudar os cortes, dizer o que cortar ou abrir no editor">
            Cortes
          </button>
        )}
        {!video.data.youtube && (
          <button onClick={() => onBrief(video)} title="Dizer como você quer a edição deste vídeo e onde o fluxo para">
            Pedido
          </button>
        )}
        {video.status === "review" && (
          <button className="primary" onClick={() => onReview(video.id)}>
            Revisar
          </button>
        )}
        {working && (
          <button onClick={() => void act("pauseVideo", video.id)} title="Pausar este vídeo">
            <Icon name="pause" />
          </button>
        )}
        {(video.status === "paused" || video.status === "error") && (
          <button onClick={() => void act("resumeVideo", video.id)} title={video.status === "error" ? "Tentar de novo" : "Retomar"}>
            <Icon name="play" />
          </button>
        )}
        <select
          value=""
          title="Refazer a partir de uma etapa"
          onChange={(e) => {
            if (e.target.value) void act("redo", video.id, e.target.value);
          }}
        >
          <option value="">Refazer…</option>
          {stages.map((s) => (
            <option key={s.name} value={s.name}>
              a partir de {s.label}
            </option>
          ))}
        </select>
        <button onClick={() => void act("setPriority", video.id, video.priority + 1)} title="Subir na fila">
          ▲
        </button>
        <button onClick={() => void act("setPriority", video.id, video.priority - 1)} title="Descer na fila">
          ▼
        </button>
        <button
          className="danger-btn"
          title="Tirar do Estúdio. O arquivo original não é apagado."
          onClick={() => confirm(`Tirar "${video.title}" do Estúdio? O que os agentes fizeram será apagado; o vídeo original fica onde está.`) && void act("removeVideo", video.id)}
        >
          <Icon name="trash" />
        </button>
      </div>
    </article>
  );
}

export function Dashboard({ onReview, onCuts }: { onReview: (id: number) => void; onCuts: (id: number) => void }) {
  const state = useStudio((s) => s.state!);
  const system = useStudio((s) => s.system) ?? state.system;
  const [over, setOver] = useState(false);
  /** Recordings picked but not yet in the studio: the creator says first how they want them edited. */
  const [incoming, setIncoming] = useState<string[] | null>(null);
  const [briefFor, setBriefFor] = useState<number | null>(null);
  const [planning, setPlanning] = useState(false);
  const briefVideo = state.videos.find((v) => v.id === briefFor) ?? null;

  const add = async () => {
    const files = await window.api.studioCall("pickVideos");
    if (files?.length) setIncoming(files);
  };

  /** A video sits in the column of the stage it is at; finished ones go to the two last columns. */
  const columnOf = (v: StudioVideo) => {
    if (v.status === "review") return "review";
    if (v.status === "approved" || v.status === "rejected") return "done";
    return (v.stages.find((s) => s.status !== "done" && s.status !== "skipped") ?? v.stages[v.stages.length - 1]).name;
  };
  const columns = [...state.stages.map((s) => ({ id: s.name, label: s.label })), { id: "review", label: "Aguardando aprovação" }, { id: "done", label: "Finalizados" }];

  return (
    <div
      className={`dashboard${over ? " drop-over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const files = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean);
        if (files.length) setIncoming(files);
      }}
    >
      {incoming && <BriefDialog files={incoming} onClose={() => setIncoming(null)} />}
      {briefVideo && <BriefDialog video={briefVideo} onClose={() => setBriefFor(null)} />}
      <section className="agents-row">
        {state.agents.map((a) => (
          <div key={a.id} className={`agent-chip agent-${a.status}`} title={a.error ?? undefined}>
            <span className="agent-light" />
            <div>
              <b>{a.label}</b>
              <small>{a.status === "running" ? `rodando${a.jobs > 1 ? ` (${a.jobs})` : ""}` : a.status === "paused" ? "parado" : a.status === "error" ? "erro" : "ocioso"}</small>
            </div>
            {a.status === "paused" ? (
              <button onClick={() => void act("pauseAgent", a.id, false)} title="Iniciar">
                <Icon name="play" />
              </button>
            ) : (
              <>
                <button onClick={() => void act("pauseAgent", a.id, true)} title="Pausar: termina o que está fazendo e não pega nada novo">
                  <Icon name="pause" />
                </button>
                <button onClick={() => void act("stopAgent", a.id)} disabled={a.status !== "running"} title="Parar agora: o trabalho atual volta para a fila">
                  ■
                </button>
              </>
            )}
          </div>
        ))}
        <div className="grow" />
        <div className="meters">
          <Meter label="CPU" value={system.cpu} />
          {system.gpu ? <Meter label="GPU" value={system.gpu.load} detail={`${system.gpu.name} · ${system.gpu.memoryUsed} de ${system.gpu.memoryTotal} MB`} /> : null}
        </div>
      </section>

      {planning && <ReleasePlan onClose={() => setPlanning(false)} />}
      <section className="kanban-head">
        <button className="primary" onClick={() => void add()}>
          <Icon name="plus" /> Adicionar vídeos brutos
        </button>
        <button onClick={() => setPlanning(true)} title="Escolher quando cada vídeo sai no YouTube: um a cada poucos dias, no melhor horário">
          Programar lançamentos
        </button>
        <span className="studio-hint">
          Ou arraste os arquivos para cá. Antes de começar você diz como quer a edição e onde o fluxo para.
          {state.settings.watch.enabled ? ` Pasta monitorada: ${state.settings.watch.folder}` : ""}
        </span>
      </section>

      <section className="kanban">
        {columns.map((col) => {
          const videos = state.videos.filter((v) => v.data.kind !== "short" && columnOf(v) === col.id);
          return (
            <div key={col.id} className={`kanban-col col-${col.id}`}>
              <h3>
                {col.label} <span>{videos.length}</span>
              </h3>
              <div className="kanban-cards">
                {videos.map((v) => (
                  <VideoCard key={v.id} video={v} onReview={onReview} onCuts={onCuts} onBrief={(video) => setBriefFor(video.id)} />
                ))}
              </div>
            </div>
          );
        })}
      </section>

      <section className="dashboard-logs">
        <h3>O que os agentes fizeram</h3>
        <Logs limit={80} />
      </section>
    </div>
  );
}

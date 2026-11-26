import { useEffect, useMemo, useState } from "react";
import { mediaUrl } from "../engine/mediaPool";
import { PublishBox } from "./Publish";
import { act, call, clock, useStudio, type ShortIdea, type StudioVideo } from "./store";

const FRAMES: { id: NonNullable<ShortIdea["frame"]>; label: string; hint: string }[] = [
  { id: "square", label: "Quadrado", hint: "Imagem quadrada no meio, fundo desfocado, legenda embaixo" },
  { id: "fill", label: "Tela cheia", hint: "Corta as laterais e enche a tela do celular" },
  { id: "fit", label: "Vídeo inteiro", hint: "A imagem toda, menor, sobre o fundo desfocado" },
];

interface Entry {
  key: string;
  parent: StudioVideo;
  idea: ShortIdea;
  row: StudioVideo | null;
}

type Stage = "idea" | "rendering" | "ready" | "approved" | "sending" | "sent" | "error";

function stageOf(row: StudioVideo | null): Stage {
  if (!row) return "idea";
  if (row.data.youtube) return "sent";
  if (row.data.publish && ["queued", "uploading", "waiting"].includes(row.data.publish.status)) return "sending";
  if (row.status === "error") return "error";
  if (row.status === "queued" || row.status === "running") return "rendering";
  if (row.status === "approved") return "approved";
  return "ready";
}

const STAGE_LABEL: Record<Stage, string> = { idea: "Sugestão", rendering: "Gerando", ready: "Pronto: falta aprovar", approved: "Aprovado", sending: "Enviando", sent: "No YouTube", error: "Erro" };

function Card({ entry, picked, onPick }: { entry: Entry; picked: boolean; onPick: (on: boolean) => void }) {
  const { parent, idea, row } = entry;
  const defaults = useStudio((s) => s.state!.settings.shorts);
  const stage = stageOf(row);
  const sent = stage === "sent";
  const [title, setTitle] = useState(idea.title);
  const [hook, setHook] = useState(idea.hook ?? "");
  const [start, setStart] = useState(String(idea.start));
  const [end, setEnd] = useState(String(idea.end));
  const [body, setBody] = useState(row?.data.metadata?.body ?? "");
  useEffect(() => setTitle(idea.title), [idea.title]);
  useEffect(() => setHook(idea.hook ?? ""), [idea.hook]);
  useEffect(() => setStart(String(idea.start)), [idea.start]);
  useEffect(() => setEnd(String(idea.end)), [idea.end]);
  useEffect(() => setBody(row?.data.metadata?.body ?? ""), [row?.id, row?.data.metadata?.body]);

  const set = (patch: Partial<ShortIdea>) => void act("setShort", parent.id, idea.id, patch);
  const frame = idea.frame ?? defaults.frame;
  const captions = idea.captions ?? defaults.captions;
  const length = idea.end - idea.start;
  const final = row?.data.finalPath && stage !== "rendering" ? row : null;

  return (
    <article className={`short-card stage-${stage}${picked ? " picked" : ""}`}>
      <header>
        <label title="Selecionar para as ações em grupo">
          <input type="checkbox" checked={picked} disabled={sent} onChange={(e) => onPick(e.target.checked)} />
        </label>
        <span className={`short-stage stage-${stage}`}>{stage === "rendering" && row?.data.render ? `Gerando ${Math.round((row.data.render.progress ?? 0) * 100)}%` : STAGE_LABEL[stage]}</span>
        <span className="grow" />
        {idea.story && <b className="short-story" title="Para os Stories do Instagram, WhatsApp ou TikTok: abra a pasta e poste pelo celular. Não vai ao YouTube.">Story</b>}
        <small title={idea.story ? "Feito pelo agente de Shorts para divulgar o vídeo" : idea.source === "prompt" ? "Pedido por você no painel de IA" : "Sugerido pelo agente de Corte"}>
          {idea.story ? "divulgação" : idea.source === "prompt" ? "pedido seu" : "sugestão"} · nota {idea.score}
        </small>
      </header>

      <div className="short-body">
        <div className="short-preview">
          {final ? (
            <video key={`${final.data.finalPath}-${final.data.renderedAt}`} src={`${mediaUrl(final.data.finalPath!)}?v=${final.data.renderedAt}`} poster={final.data.cover ? `${mediaUrl(final.data.cover)}?v=${final.data.renderedAt}` : undefined} controls preload="none" />
          ) : (
            <div className="short-empty">
              {parent.data.thumb ? <img src={mediaUrl(parent.data.thumb)} alt="" /> : null}
              <span>{stage === "rendering" ? (row?.data.render?.message ?? "Na fila") : "Ainda não gerado"}</span>
            </div>
          )}
        </div>

        <div className="short-fields">
          <input className="short-title" value={title} maxLength={100} disabled={sent} onChange={(e) => setTitle(e.target.value)} onBlur={() => title.trim() && title.trim() !== idea.title && set({ title })} title="Título do Short no YouTube" />
          <small className="short-from">
            {parent.title} · {clock(idea.start)}–{clock(idea.end)} · {Math.round(length)} s
          </small>
          {idea.reason && <p className="short-reason">{idea.reason}</p>}

          <div className="short-row">
            <label className="field compact" title="Começo do trecho, em segundos da gravação original">
              <span>Início (s)</span>
              <input type="number" step={0.5} min={0} value={start} disabled={sent} onChange={(e) => setStart(e.target.value)} onBlur={() => Number(start) !== idea.start && set({ start: Number(start) })} />
            </label>
            <label className="field compact" title="Fim do trecho, em segundos da gravação original">
              <span>Fim (s)</span>
              <input type="number" step={0.5} min={0} value={end} disabled={sent} onChange={(e) => setEnd(e.target.value)} onBlur={() => Number(end) !== idea.end && set({ end: Number(end) })} />
            </label>
            <label className="field compact">
              <span>Enquadramento</span>
              <select value={frame} disabled={sent} onChange={(e) => set({ frame: e.target.value as ShortIdea["frame"] })} title={FRAMES.find((f) => f.id === frame)?.hint}>
                {FRAMES.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="short-row">
            <label className="field compact grow" title="Texto fixo no alto do vídeo. Vazio = sem texto.">
              <span>Texto no alto (opcional)</span>
              <input value={hook} maxLength={40} disabled={sent} placeholder="Ex.: OLHA O QUE ACONTECEU" onChange={(e) => setHook(e.target.value)} onBlur={() => hook.trim() !== (idea.hook ?? "") && set({ hook })} />
            </label>
            <label className="short-check">
              <input type="checkbox" checked={captions} disabled={sent} onChange={(e) => set({ captions: e.target.checked })} /> Legendas
            </label>
          </div>
          {frame !== "fit" && (
            <label className="short-focus" title="Que parte da imagem fica no quadro: esquerda, centro ou direita">
              <span>Foco</span>
              <input type="range" min={0} max={1} step={0.05} defaultValue={idea.focus ?? 0.5} disabled={sent} onMouseUp={(e) => set({ focus: Number((e.target as HTMLInputElement).value) })} onKeyUp={(e) => set({ focus: Number((e.target as HTMLInputElement).value) })} />
            </label>
          )}

          {row?.error && stage === "error" && <p className="card-error">{row.error}</p>}

          <div className="short-actions">
            {stage === "idea" && <button onClick={() => void act("makeShorts", parent.id, [idea.id])}>Gerar Short</button>}
            {(stage === "error" || stage === "ready" || stage === "approved") && (
              <button onClick={() => void act("makeShorts", parent.id, [idea.id])} title="Renderiza de novo com as opções acima">
                Gerar de novo
              </button>
            )}
            {stage === "ready" && (
              <button className="primary" onClick={() => void act("approve", row!.id)} title="Você viu e aprova este Short exatamente como está">
                Aprovar
              </button>
            )}
            {stage === "approved" && (
              <button onClick={() => void act("reopen", row!.id)} title="Tira a aprovação">
                Voltar para a revisão
              </button>
            )}
            {final && <button onClick={() => void act("reveal", final.data.finalPath)}>Abrir a pasta</button>}
            <button onClick={() => void act("shortInEditor", parent.id, idea.id)} title="Abre este Short no editor como projeto vertical 1080×1920, com o trecho, o enquadramento, o texto e as legendas em clipes separados, para você mexer à mão">
              Abrir no editor
            </button>
            {idea.editorProject && !sent && (
              <button onClick={() => void act("useExportedShort", parent.id, idea.id)} title="Depois de editar no editor e clicar em Exportar, escolha o arquivo exportado: ele vira este Short, para você aprovar e enviar ao YouTube">
                Usar o vídeo exportado
              </button>
            )}
            <span className="grow" />
            {!sent && (
              <button className="danger" onClick={() => confirm(`Excluir "${idea.title}"?${row ? " O Short gerado também é apagado." : ""}`) && void act("removeShort", parent.id, idea.id)}>
                Excluir
              </button>
            )}
          </div>

          {row && final && idea.story && <p className="studio-hint">Story pronto. Clique em Abrir a pasta, mande o arquivo para o celular e poste nos Stories. Ele não vai ao YouTube.</p>}
          {row && final && !idea.story && (
            <details className="short-publish" open={stage === "approved" || stage === "sending" || sent}>
              <summary>Descrição e publicação</summary>
              <label className="field">
                <span>Descrição (a hashtag #shorts entra sozinha)</span>
                <textarea rows={3} value={body} disabled={sent || stage === "sending"} onChange={(e) => setBody(e.target.value)} onBlur={() => body !== (row.data.metadata?.body ?? "") && void act("setMetadata", row.id, { body })} />
              </label>
              <PublishBox video={row} busy={false} />
            </details>
          )}
        </div>
      </div>
    </article>
  );
}

/** Asks the Shorts agent to look at one recording now: speech, action on screen and frames. */
function FindButton({ parentId }: { parentId: number | null }) {
  const busy = useStudio((s) => s.state!.agents.find((a) => a.id === "shorts")?.status === "running");
  const title = useStudio((s) => s.state!.videos.find((v) => v.id === parentId)?.title);
  if (!parentId) return null;
  return (
    <button disabled={busy} onClick={() => void act("autoShorts", parentId)} title={`O agente de Shorts olha "${title}" sozinho (fala, ação na tela e quadros da imagem), acha os momentos e gera os melhores e um Story. Cada um espera a sua aprovação.`}>
      {busy ? "Agente trabalhando…" : "Achar Shorts sozinho"}
    </button>
  );
}

/** The Shorts agent working on its own: what it makes when a video is ready. */
function AutoBar() {
  const cfg = useStudio((s) => s.state!.settings.shorts);
  const set = (patch: Partial<typeof cfg>) => void act("setSettings", { shorts: patch });
  return (
    <div className="shorts-auto">
      <label className="short-check" title="Quando um vídeo fica pronto, o agente gera sozinho os melhores Shorts dele. Nada é enviado: cada um espera a sua aprovação.">
        <input type="checkbox" checked={cfg.auto} onChange={(e) => set({ auto: e.target.checked })} /> <b>Agente de Shorts no automático</b>
      </label>
      <span>gera os</span>
      <select value={cfg.count} disabled={!cfg.auto} onChange={(e) => set({ count: Number(e.target.value) })}>
        {[1, 2, 3, 4, 5, 6].map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
      <span>melhores momentos com nota</span>
      <select value={cfg.minScore} disabled={!cfg.auto} onChange={(e) => set({ minScore: Number(e.target.value) })}>
        {[50, 60, 70, 80, 90].map((n) => (
          <option key={n} value={n}>
            {n}+
          </option>
        ))}
      </select>
      <label className="short-check" title="Um vídeo vertical de até 30 s com o melhor momento e 'VÍDEO NOVO NO CANAL!' no alto, para postar nos Stories do Instagram, WhatsApp ou TikTok">
        <input type="checkbox" checked={cfg.stories} disabled={!cfg.auto} onChange={(e) => set({ stories: e.target.checked })} /> e 1 Story de divulgação
      </label>
    </div>
  );
}

/** The AI panel: a request in plain words about the moments of one recording. */
function AskPanel({ parents, parentId, onParent }: { parents: StudioVideo[]; parentId: number | null; onParent: (id: number) => void }) {
  const claude = useStudio((s) => s.state!.claude);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [talk, setTalk] = useState<{ who: "you" | "agent" | "error"; text: string }[]>([]);
  const send = async () => {
    const request = text.trim();
    if (!request || !parentId || busy) return;
    setBusy(true);
    setTalk((t) => [...t, { who: "you", text: request }]);
    setText("");
    try {
      const out = await call<{ reply: string; added: number[]; changed: number[]; removed: number[] }>("askShorts", parentId, request);
      setTalk((t) => [...t, { who: "agent", text: `${out.reply}${out.added.length || out.changed.length || out.removed.length ? ` (${out.added.length} novo(s), ${out.changed.length} alterado(s), ${out.removed.length} removido(s))` : ""}` }]);
    } catch (err) {
      setTalk((t) => [...t, { who: "error", text: (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") }]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside className="shorts-ask">
      <h3>Pedir ao agente de Shorts</h3>
      <label className="field">
        <span>Vídeo</span>
        <select value={parentId ?? ""} onChange={(e) => onParent(Number(e.target.value))}>
          {parents.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
      </label>
      <div className="shorts-talk">
        {!talk.length && (
          <p className="studio-hint">
            Exemplos: "ache mais 3 momentos engraçados", "um short da parte em que eu falo da bancada", "o short 2 começa 3 segundos antes", "tira a legenda do primeiro", "põe o texto NÃO FAÇA ISSO no alto do short da casinha".
          </p>
        )}
        {talk.map((m, i) => (
          <p key={i} className={`talk-${m.who}`}>
            {m.text}
          </p>
        ))}
        {busy && <p className="talk-agent">Pensando…</p>}
      </div>
      <textarea
        rows={3}
        value={text}
        disabled={busy || !parentId || !claude}
        placeholder={claude ? "Escreva o que você quer" : "Precisa do Claude Code instalado"}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <button className="primary" disabled={busy || !text.trim() || !parentId || !claude} onClick={() => void send()}>
        Pedir
      </button>
      <p className="studio-hint">Os pedidos escritos usam só o que foi falado. "Achar Shorts sozinho" e o modo automático também olham a ação medida na tela e os quadros. Nada é enviado ao YouTube por aqui: cada Short espera a sua aprovação.</p>
    </aside>
  );
}

/** A Short finished by the creator in the editor ("Publicar"): watch, approve, set the date, send. */
function MineCard({ row }: { row: StudioVideo }) {
  const stage = stageOf(row);
  const sent = stage === "sent";
  const [title, setTitle] = useState(row.data.metadata?.title ?? row.title);
  const [body, setBody] = useState(row.data.metadata?.body ?? "");
  useEffect(() => setTitle(row.data.metadata?.title ?? row.title), [row.data.metadata?.title]);
  useEffect(() => setBody(row.data.metadata?.body ?? ""), [row.data.metadata?.body]);
  const parentTitle = useStudio((s) => (row.data.parentId ? s.state!.videos.find((v) => v.id === row.data.parentId)?.title : null));
  return (
    <article className={`short-card stage-${stage}`}>
      <header>
        <span className={`short-stage stage-${stage}`}>{STAGE_LABEL[stage]}</span>
        <span className="grow" />
        <small>{parentTitle ? `editado por você · de "${parentTitle}"` : "editado por você"}</small>
      </header>
      <div className="short-body">
        <div className="short-preview">
          {row.data.finalPath ? (
            <video key={`${row.data.finalPath}-${row.data.renderedAt}`} src={`${mediaUrl(row.data.finalPath)}?v=${row.data.renderedAt}`} poster={row.data.cover ? mediaUrl(row.data.cover) : undefined} controls preload="none" />
          ) : (
            <div className="short-empty">
              <span>Sem vídeo</span>
            </div>
          )}
        </div>
        <div className="short-fields">
          <input className="short-title" value={title} maxLength={100} disabled={sent} onChange={(e) => setTitle(e.target.value)} onBlur={() => title.trim() && title !== (row.data.metadata?.title ?? "") && void act("setMetadata", row.id, { title })} title="Título no YouTube" />
          <small className="short-from">{Math.round(row.data.duration ?? 0)} s · do editor</small>
          <label className="field">
            <span>Descrição (a hashtag #shorts entra sozinha)</span>
            <textarea rows={3} value={body} disabled={sent} onChange={(e) => setBody(e.target.value)} onBlur={() => body !== (row.data.metadata?.body ?? "") && void act("setMetadata", row.id, { body })} />
          </label>
          <div className="short-actions">
            {stage === "ready" && (
              <button className="primary" onClick={() => void act("approve", row.id)} title="Você viu e aprova este Short exatamente como está">
                Aprovar
              </button>
            )}
            {stage === "approved" && <button onClick={() => void act("reopen", row.id)}>Voltar para a revisão</button>}
            {row.data.editorProject && !sent && <button onClick={() => void act("openMineInEditor", row.id)}>Abrir no editor</button>}
            {row.data.finalPath && <button onClick={() => void act("reveal", row.data.finalPath)}>Abrir a pasta</button>}
            <span className="grow" />
            {!sent && !row.data.parentId && (
              <button className="danger" onClick={() => confirm(`Tirar "${title}" do Estúdio? O arquivo exportado e o seu projeto ficam no computador.`) && void act("removeVideo", row.id)}>
                Excluir
              </button>
            )}
          </div>
          <PublishBox video={row} busy={false} />
        </div>
      </div>
    </article>
  );
}

export function Shorts() {
  const videos = useStudio((s) => s.state!.videos);
  const youtube = useStudio((s) => s.state!.youtube);
  const [view, setView] = useState<"agent" | "mine">("agent");
  // Finished by the creator in the editor: their own list. A Short of a recording they redid there moves to it.
  const mine = useMemo(() => videos.filter((v) => v.data.kind === "short" && v.data.mine).sort((a, b) => b.id - a.id), [videos]);
  const [filter, setFilter] = useState<number | "all">("all");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [askFor, setAskFor] = useState<number | null>(null);

  const parents = useMemo(() => videos.filter((v) => v.data.kind !== "short" && v.data.duration), [videos]);
  const entries = useMemo<Entry[]>(() => {
    const rows = videos.filter((v) => v.data.kind === "short");
    return parents
      .filter((p) => filter === "all" || p.id === filter)
      .flatMap((parent) =>
        [...(parent.data.shorts ?? [])]
          .sort((a, b) => b.score - a.score)
          .map((idea) => ({ key: `${parent.id}:${idea.id}`, parent, idea, row: rows.find((r) => r.data.parentId === parent.id && r.data.shortId === idea.id) ?? null }))
          .filter((e) => !e.row?.data.mine),
      );
  }, [videos, parents, filter]);
  const askParent = askFor ?? (filter !== "all" ? filter : (parents[parents.length - 1]?.id ?? null));

  const chosen = entries.filter((e) => picked.has(e.key));
  const toMake = chosen.filter((e) => ["idea", "error"].includes(stageOf(e.row)));
  const toApprove = chosen.filter((e) => stageOf(e.row) === "ready");
  const toSend = chosen.filter((e) => stageOf(e.row) === "approved" && !e.idea.story);
  const pick = (key: string, on: boolean) =>
    setPicked((before) => {
      const next = new Set(before);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const makeAll = async () => {
    const byParent = new Map<number, number[]>();
    for (const e of toMake) byParent.set(e.parent.id, [...(byParent.get(e.parent.id) ?? []), e.idea.id]);
    for (const [parentId, ids] of byParent) await act("makeShorts", parentId, ids);
  };
  const approveAll = async () => {
    if (!confirm(`Aprovar ${toApprove.length} Short(s) exatamente como estão? Aprove só o que você já assistiu.`)) return;
    for (const e of toApprove) await act("approve", e.row!.id);
  };
  const sendAll = async () => {
    if (!confirm(`Enviar ${toSend.length} Short(s) aprovado(s) ao YouTube?`)) return;
    for (const e of toSend) await act("publish", e.row!.id);
  };

  const tabs = (
    <nav className="shorts-views">
      <button className={view === "agent" ? "active" : ""} onClick={() => setView("agent")}>
        Do agente
      </button>
      <button className={view === "mine" ? "active" : ""} onClick={() => setView("mine")} title="Shorts que você terminou no editor e mandou com Publicar">
        Editados por mim {mine.length ? <b className="badge">{mine.length}</b> : null}
      </button>
    </nav>
  );

  if (view === "mine")
    return (
      <div className="shorts-tab">
        <section className="shorts-list">
          {tabs}
          <p className="studio-hint">Shorts que você terminou no editor e mandou com o botão Publicar. Nenhum agente mexe neles. Assista, aprove e escolha a data; eles também aparecem no Calendário.</p>
          {mine.length ? (
            <div className="shorts-cards">
              {mine.map((row) => (
                <MineCard key={row.id} row={row} />
              ))}
            </div>
          ) : (
            <p className="studio-empty big">Nenhum ainda. No editor, com o Short pronto, clique em Publicar e escolha "Short".</p>
          )}
        </section>
      </div>
    );

  if (!parents.length)
    return (
      <div className="shorts-tab">
        <section className="shorts-list">
          {tabs}
          <p className="studio-empty big">Os Shorts sugeridos aparecem aqui depois que um vídeo passa pelo Estúdio. Arraste uma gravação para o Painel.</p>
        </section>
      </div>
    );

  return (
    <div className="shorts-tab">
      <section className="shorts-list">
        {tabs}
        <header className="shorts-bar">
          <select value={filter} onChange={(e) => setFilter(e.target.value === "all" ? "all" : Number(e.target.value))}>
            <option value="all">Todos os vídeos</option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title} ({(p.data.shorts ?? []).length})
              </option>
            ))}
          </select>
          <FindButton parentId={askParent} />
          <button onClick={() => setPicked(new Set(chosen.length === entries.length ? [] : entries.filter((e) => stageOf(e.row) !== "sent").map((e) => e.key)))}>{chosen.length === entries.length && entries.length ? "Limpar seleção" : "Selecionar todos"}</button>
          <span className="grow" />
          <button disabled={!toMake.length} onClick={() => void makeAll()} title="Renderiza na vertical os selecionados que ainda não foram gerados">
            Gerar selecionados ({toMake.length})
          </button>
          <button disabled={!toApprove.length} onClick={() => void approveAll()} title="Aprova os selecionados que já estão prontos">
            Aprovar selecionados ({toApprove.length})
          </button>
          <button className="primary" disabled={!toSend.length || !youtube.connected} onClick={() => void sendAll()} title={youtube.connected ? "Envia ao YouTube os selecionados que você já aprovou" : "Conecte o canal nas Configurações"}>
            Enviar ao YouTube ({toSend.length})
          </button>
        </header>
        <AutoBar />
        <p className="studio-hint">Marque os que você quer, gere, assista e aprove. Só Short aprovado pode ser enviado; mudar qualquer coisa depois de aprovar pede aprovação de novo.</p>
        {entries.length ? (
          <div className="shorts-cards">
            {entries.map((e) => (
              <Card key={e.key} entry={e} picked={picked.has(e.key)} onPick={(on) => pick(e.key, on)} />
            ))}
          </div>
        ) : (
          <p className="studio-empty big">Nenhuma sugestão de Short para este vídeo. Peça ao agente, ao lado.</p>
        )}
      </section>
      <AskPanel parents={parents} parentId={askParent} onParent={setAskFor} />
    </div>
  );
}

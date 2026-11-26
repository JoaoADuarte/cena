import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/controls";
import { mediaUrl } from "../engine/mediaPool";
import { Logs } from "./Logs";
import { ThumbEditor } from "./ThumbEditor";
import { MetadataEditor, PublishBox } from "./Publish";
import { act, clock, useStudio, type Cut, type EditItem, type EditSettings, type StudioVideo } from "./store";

const KIND_COLOR: Record<string, string> = {
  silêncio: "#5b6b8a",
  hesitação: "#b98a2c",
  gaguejo: "#b9652c",
  parado: "#6b5b8a",
  "sem fala": "#4a6b6b",
  "take repetido": "#c0455a",
  erro: "#c0455a",
  enrolação: "#a04a8a",
  pedido: "#22c3b5",
};

const EDIT_FLAGS: { key: keyof EditSettings; label: string; items?: "zooms" | "texts" | "sections" | "broll" }[] = [
  { key: "captions", label: "Legendas" },
  { key: "zooms", label: "Zooms", items: "zooms" },
  { key: "texts", label: "Textos na tela", items: "texts" },
  { key: "transitions", label: "Transições", items: "sections" },
  { key: "music", label: "Música de fundo" },
  { key: "colour", label: "Correção de cor" },
  { key: "broll", label: "Imagens de apoio", items: "broll" },
];

/** Original recording time → finished video time (null when that moment was cut out). */
function toFinal(cuts: Cut[], time: number) {
  let removed = 0;
  for (const c of [...cuts].filter((x) => x.enabled).sort((a, b) => a.start - b.start)) {
    if (time >= c.end) removed += c.end - c.start;
    else if (time > c.start) return null;
    else break;
  }
  return time - removed;
}

/** Where in the finished video each cut happens, and how much was taken out before it. */
function finalTimes(cuts: Cut[]) {
  let removed = 0;
  return cuts.map((c) => {
    const final = c.start - removed;
    if (c.enabled) removed += c.end - c.start;
    return { ...c, final };
  });
}

/** One thumbnail over the whole screen: arrows go through the others, Esc or a click outside closes. */
function ThumbViewer({ thumbs, index, chosen, busy, onIndex, onChoose, onClose, onEdit }: { thumbs: NonNullable<StudioVideo["data"]["thumbnails"]>; index: number; chosen?: string; busy: boolean; onIndex: (i: number) => void; onChoose: (i: number) => void; onClose: () => void; onEdit: (i: number) => void }) {
  const t = thumbs[index];
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") onIndex((index + 1) % thumbs.length);
      else if (e.key === "ArrowLeft") onIndex((index - 1 + thumbs.length) % thumbs.length);
      else if (e.key === "Enter" && !busy) onChoose(index);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [index, thumbs.length, busy, onIndex, onChoose, onClose]);
  return (
    <div className="thumb-viewer" onClick={onClose}>
      <img src={mediaUrl(t.path)} alt={t.text} onClick={(e) => e.stopPropagation()} />
      <div className="thumb-viewer-bar" onClick={(e) => e.stopPropagation()}>
        <button onClick={() => onIndex((index - 1 + thumbs.length) % thumbs.length)} title="Anterior (←)">
          ‹
        </button>
        <span>
          {index + 1} de {thumbs.length} · "{t.text}"{t.path === chosen ? " · escolhida" : ""}
        </span>
        <button onClick={() => onIndex((index + 1) % thumbs.length)} title="Próxima (→)">
          ›
        </button>
        <button className="primary" disabled={busy || t.path === chosen} onClick={() => onChoose(index)} title="Enter">
          {t.path === chosen ? "Escolhida" : "Usar esta"}
        </button>
        <button disabled={busy} onClick={() => onEdit(index)} title="Mudar texto, tirar a seta, o rosto…, adicionar textos e imagens">
          Editar
        </button>
        <button onClick={onClose} title="Fechar (Esc)">
          Fechar
        </button>
      </div>
    </div>
  );
}

function Detail({ video }: { video: StudioVideo }) {
  const stages = useStudio((s) => s.state!.stages);
  const defaults = useStudio((s) => s.state!.settings.edit);
  const [thumbText, setThumbText] = useState("");
  const [thumbNote, setThumbNote] = useState("");
  const [thumbImages, setThumbImages] = useState<string[]>([]);
  const [viewing, setViewing] = useState<number | null>(null);
  const [editingThumb, setEditingThumb] = useState<number | null>(null);
  const finalRef = useRef<HTMLVideoElement>(null);
  const originalRef = useRef<HTMLVideoElement>(null);
  const [compare, setCompare] = useState(false);
  const [request, setRequest] = useState("");
  const [reply, setReply] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [title, setTitle] = useState(video.title);
  const [filter, setFilter] = useState<"all" | "on" | "off">("all");
  useEffect(() => setTitle(video.title), [video.id, video.title]);

  const cuts = useMemo(() => finalTimes(video.data.cuts ?? []), [video.data.cuts]);
  const duration = video.data.duration ?? 1;
  const on = cuts.filter((c) => c.enabled);
  const removed = on.reduce((sum, c) => sum + c.end - c.start, 0);
  const busy = video.status === "running" || video.status === "queued";
  const stage = video.stages.find((s) => s.status === "running");
  const audio = video.stages.find((s) => s.name === "audio");

  /** Show a cut: the finished video a little before the jump, the original a little before the removed part. */
  const show = (cut: Cut & { final: number }) => {
    if (finalRef.current) {
      finalRef.current.currentTime = Math.max(0, cut.final - 2);
      void finalRef.current.play().catch(() => {});
    }
    if (originalRef.current) originalRef.current.currentTime = Math.max(0, cut.start - 2);
  };

  const send = async () => {
    setSending(true);
    setReply(null);
    const out = (await act("correct", video.id, request)) as { reply: string } | undefined;
    setSending(false);
    if (out) {
      setReply(out.reply);
      setRequest("");
    }
  };

  const editing: EditSettings = { ...defaults, ...(video.data.overrides?.edit ?? {}) };
  const plan = video.data.edit;
  const made = video.data.editDone;
  const thumbs = video.data.thumbnails ?? [];
  const texts = (plan?.texts ?? []).map((t: EditItem) => ({ ...t, final: toFinal(video.data.cuts ?? [], t.time) })).filter((t) => t.final !== null);
  const seek = (time: number) => {
    if (!finalRef.current) return;
    finalRef.current.currentTime = Math.max(0, time - 1);
    void finalRef.current.play().catch(() => {});
  };

  const listed = cuts.filter((c) => (filter === "all" ? true : filter === "on" ? c.enabled : !c.enabled));

  return (
    <div className="review-detail">
      <header>
        <input
          className="review-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== video.title && void act("setVideo", video.id, { title })}
          title="Título de trabalho, só para o painel. O título do YouTube fica mais abaixo."
        />
        <span className={`review-status status-${video.status}`}>
          {video.status === "approved" ? "Aprovado" : video.status === "rejected" ? "Rejeitado" : busy ? (stage?.message ?? "Processando") : "Aguardando a sua aprovação"}
        </span>
      </header>

      <div className={`players${compare ? " two" : ""}`}>
        <figure>
          <figcaption>
            Vídeo final · {clock(video.data.finalDuration ?? 0)}
            {video.data.dirty ? " · desatualizado: há alterações não renderizadas" : ""}
          </figcaption>
          {video.data.finalPath ? <video key={`${video.data.finalPath}-${video.data.renderedAt}`} ref={finalRef} src={`${mediaUrl(video.data.finalPath)}?v=${video.data.renderedAt}`} controls /> : <div className="player-empty">Ainda não renderizado</div>}
        </figure>
        {compare && (
          <figure>
            <figcaption>Original · {clock(duration)}</figcaption>
            <video ref={originalRef} src={mediaUrl(video.source_path)} controls />
          </figure>
        )}
      </div>
      <div className="review-tools">
        <label className="toggle-row">
          <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} />
          <span>Comparar com o original</span>
        </label>
        <span className="studio-hint">
          {on.length} cortes tiram {clock(removed)} de {clock(duration)}
          {audio?.status === "done" ? " · áudio limpo e no volume do YouTube" : ""}
        </span>
        <div className="grow" />
        {video.data.projectPath && !video.data.youtube && (
          <button onClick={() => void act("openProjectInEditor", video.id)} title="Abre o projeto no editor do Cena para mudar o que quiser. Depois, salve e volte aqui.">
            <Icon name="film" /> Abrir no editor
          </button>
        )}
        {!video.data.youtube && video.stages.find((s) => s.name === "cut")?.status === "done" && (
          <button
            onClick={() => confirm("Voltar ao início do fluxo? O vídeo para antes da Edição: você muda os cortes (aqui ou no editor) e o pedido, e clica em Continuar. A edição e a montagem são refeitas; transcrição, som, título e thumbnails ficam.") && void act("backToStart", video.id, { fromEditor: false })}
            title="Como a parada depois do Corte: mudar os cortes e o pedido e seguir o fluxo de novo"
          >
            Voltar ao início
          </button>
        )}
        {video.data.projectPath && (
          <button onClick={() => void act("reveal", video.data.projectPath)} title="O projeto também aparece nos projetos recentes do editor, para ajustar à mão">
            <Icon name="folder" /> Projeto do Cena
          </button>
        )}
        {video.data.finalPath && (
          <button onClick={() => void act("reveal", video.data.finalPath)}>
            <Icon name="film" /> Arquivo final
          </button>
        )}
      </div>

      {video.projectChanged && !video.data.youtube && (
        <div className="studio-alert editor-changed">
          <span>
            <b>Você mudou o projeto no editor.</b> O vídeo acima ainda é o de antes.
          </span>
          <button className="primary" onClick={() => void act("renderAsEdited", video.id)} title="O vídeo final passa a ser o projeto como você deixou no editor">
            Renderizar como está no editor
          </button>
          <button
            onClick={() => confirm("Levar os cortes do editor para o início do fluxo? Os agentes refazem a edição e a montagem com esses cortes; textos e efeitos que você pôs no editor não ficam. Para manter tudo como está no editor, use \"Renderizar como está no editor\".") && void act("backToStart", video.id, { fromEditor: true })}
            title="Os cortes que você fez no editor voltam para o começo do fluxo"
          >
            Voltar ao início com os cortes de lá
          </button>
        </div>
      )}
      {!video.data.finalPath && video.data.projectPath && !video.projectChanged && (
        <div className="studio-alert editor-changed">
          <span>Os agentes montaram o projeto, mas não renderizaram, como você pediu.</span>
          <button className="primary" onClick={() => void act("renderAsEdited", video.id)}>
            Renderizar agora
          </button>
        </div>
      )}

      <div className="cut-map" title="A gravação original: em cor, o que foi cortado. Clique para ver.">
        {cuts.map((c) => (
          <i
            key={c.id}
            className={c.enabled ? "on" : "off"}
            style={{ left: `${(c.start / duration) * 100}%`, width: `max(2px, ${((c.end - c.start) / duration) * 100}%)`, background: c.enabled ? (KIND_COLOR[c.kind] ?? "#c0455a") : undefined }}
            title={`${clock(c.start)} · ${c.kind}: ${c.reason}`}
            onClick={() => show(c)}
          />
        ))}
        {(video.data.shorts ?? []).map((s) => (
          <b key={s.id} style={{ left: `${(s.start / duration) * 100}%`, width: `max(3px, ${((s.end - s.start) / duration) * 100}%)` }} title={`Sugestão de Short: ${s.title}`} />
        ))}
      </div>

      {video.data.summary && <p className="review-summary">{video.data.summary}</p>}
      {(video.data.missing ?? []).length > 0 && (
        <div className="studio-alert">
          Partes do roteiro que não apareceram na gravação: {video.data.missing!.join("; ")}
        </div>
      )}

      <div className="review-columns">
        <section className="cuts">
          <h3>
            Cortes
            <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
              <option value="all">todos ({cuts.length})</option>
              <option value="on">ligados ({on.length})</option>
              <option value="off">sugestões desligadas ({cuts.length - on.length})</option>
            </select>
            {video.data.dirty && (
              <button className="primary" disabled={busy} onClick={() => void act("redo", video.id, "assemble")}>
                Aplicar e renderizar de novo
              </button>
            )}
          </h3>
          <ul>
            {listed.map((c) => (
              <li key={c.id} className={c.enabled ? "" : "off"}>
                <input type="checkbox" checked={c.enabled} disabled={busy} onChange={(e) => void act("setCut", video.id, c.id, e.target.checked)} title={c.enabled ? "Desligar: este trecho volta para o vídeo" : "Ligar: cortar este trecho"} />
                <button className="cut-time" onClick={() => show(c)} title="Ver este ponto">
                  {clock(c.final)}
                </button>
                <span className="cut-kind" style={{ background: KIND_COLOR[c.kind] ?? "#555" }}>
                  {c.kind}
                </span>
                <span className="cut-length">{(c.end - c.start).toFixed(1)} s</span>
                <span className="cut-reason">{c.reason}</span>
              </li>
            ))}
            {!listed.length && <p className="studio-empty">Nenhum corte aqui.</p>}
          </ul>
        </section>

        <section className="review-side">
          <h3>Thumbnail</h3>
          {thumbs.length ? (
            <div className="thumbs">
              {thumbs.map((t, i) => (
                <div key={t.path} className="thumb-cell">
                  <button className={t.path === video.data.thumbnail ? "chosen" : ""} disabled={busy} onClick={() => void act("setThumbnail", video.id, i)} onDoubleClick={() => setViewing(i)} title={`"${t.text}" · quadro de ${clock(t.time)} do original${t.path === video.data.thumbnail ? " · escolhida" : ""}. Duplo clique: tela cheia`}>
                    <img src={mediaUrl(t.path)} alt={t.text} />
                  </button>
                  <button className="thumb-zoom" onClick={() => setViewing(i)} title="Ver em tela cheia">
                    ⤢
                  </button>
                  <button className="thumb-zoom thumb-pencil" disabled={busy} onClick={() => setEditingThumb(i)} title="Editar esta thumb">
                    ✎
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="studio-empty">Nenhuma thumbnail ainda.</p>
          )}
          <input className="thumb-field" value={thumbText} disabled={busy} maxLength={40} onChange={(e) => setThumbText(e.target.value)} placeholder="Texto que você quer na thumb (opcional)" />
          <textarea
            className="thumb-field"
            value={thumbNote}
            disabled={busy}
            rows={2}
            maxLength={600}
            onChange={(e) => setThumbNote(e.target.value)}
            placeholder='Como você quer (opcional). Ex.: "não coloque a webcam", "use a imagem logo.png da pasta", "fundo vermelho com o carro grande"'
          />
          {thumbImages.length > 0 && (
            <div className="thumb-chips">
              {thumbImages.map((f) => (
                <span key={f} title={f}>
                  {f.split(/[\\/]/).pop()}
                  <button onClick={() => setThumbImages((l) => l.filter((x) => x !== f))} title="Tirar">
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="inline">
            <button
              disabled={busy}
              onClick={async () => {
                const picked = (await act("pickImages")) as string[] | undefined;
                if (picked?.length) setThumbImages((l) => [...new Set([...l, ...picked])].slice(0, 6));
              }}
              title="Imagens suas para o agente usar nas thumbnails (só lidas, nunca alteradas)"
            >
              Anexar imagens
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void act("redoThumbnails", video.id, { text: thumbText, note: thumbNote, images: thumbImages }).then(() => {
                  setThumbText("");
                  setThumbNote("");
                  setThumbImages([]);
                })
              }
              title="Faz novas opções a partir do vídeo, sem renderizar o vídeo de novo"
            >
              Gerar outras
            </button>
          </div>
          {viewing !== null && thumbs[viewing] && (
            <ThumbViewer
              thumbs={thumbs}
              index={viewing}
              chosen={video.data.thumbnail}
              busy={busy}
              onIndex={setViewing}
              onChoose={(i) => void act("setThumbnail", video.id, i)}
              onClose={() => setViewing(null)}
              onEdit={(i) => (setViewing(null), setEditingThumb(i))}
            />
          )}
          {editingThumb !== null && thumbs[editingThumb] && <ThumbEditor video={video} index={editingThumb} onClose={() => setEditingThumb(null)} />}
          {thumbs.length > 0 && <p className="studio-hint">Feitas só com quadros do vídeo, o recorte da pessoa e texto. 1280×720, prontas para o YouTube.</p>}

          <h3>Edição</h3>
          <div className="edit-flags">
            {EDIT_FLAGS.map((f) => {
              const count = f.items ? (plan?.[f.items] ?? []).filter((i) => i.enabled !== false).length : null;
              return (
                <label key={f.key} className="toggle-row">
                  <input type="checkbox" checked={Boolean(editing[f.key])} disabled={busy} onChange={(e) => void act("setEdit", video.id, { [f.key]: e.target.checked })} />
                  <span>
                    {f.label}
                    {count !== null && editing[f.key] ? ` (${count})` : ""}
                  </span>
                </label>
              );
            })}
          </div>
          {editing.music && (
            <label className="field">
              <span>
                Volume da música ({Math.round(editing.musicVolume * 100)}%){made?.music ? ` · "${made.music.title}" de ${made.music.creator} (${made.music.license})` : plan?.music?.query ? ` · busca: ${plan.music.query}` : ""}
              </span>
              <input type="range" min={2} max={40} value={Math.round(editing.musicVolume * 100)} disabled={busy} onChange={(e) => void act("setEdit", video.id, { musicVolume: Number(e.target.value) / 100 })} />
            </label>
          )}
          {editing.texts && texts.length > 0 && (
            <ul className="edit-items">
              {texts.map((t) => (
                <li key={t.id} className={t.enabled === false ? "off" : ""}>
                  <input type="checkbox" checked={t.enabled !== false} disabled={busy} onChange={(e) => void act("setEditItem", video.id, "texts", t.id, e.target.checked)} />
                  <button className="cut-time" onClick={() => seek(t.final!)} title="Ver este ponto">
                    {clock(t.final!)}
                  </button>
                  <input className="edit-text" defaultValue={t.text} disabled={busy} maxLength={48} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== t.text && void act("setEditText", video.id, t.id, e.target.value)} />
                </li>
              ))}
            </ul>
          )}
          {plan?.notes && <p className="studio-hint">{plan.notes}</p>}
          {video.data.dirty && (
            <button className="primary" disabled={busy} onClick={() => void act("redo", video.id, "assemble")}>
              Aplicar e renderizar de novo
            </button>
          )}
          {(video.data.credits ?? []).some((c) => c.needsCredit) && (
            <p className="studio-hint">
              Créditos para a descrição: {video.data.credits!.filter((c) => c.needsCredit).map((c) => `${c.kind} "${c.title}" de ${c.creator} (${c.license})`).join("; ")}
            </p>
          )}

          <h3>Sugestões de Shorts</h3>
          <ul className="shorts">
            {(video.data.shorts ?? []).map((s) => (
              <li key={s.id} onClick={() => originalRef.current && ((originalRef.current.currentTime = s.start), void originalRef.current.play())} title={compare ? "Ver no original" : 'Ligue "Comparar com o original" para ver'}>
                <b>{s.title}</b>
                <small>
                  {clock(s.start)}–{clock(s.end)} do original · nota {s.score}
                </small>
                <p>{s.reason}</p>
              </li>
            ))}
            {!(video.data.shorts ?? []).length && <p className="studio-empty">Nenhuma sugestão.</p>}
          </ul>
          <MetadataEditor video={video} busy={busy} />

          <h3>Pedir correções</h3>
          <textarea value={request} disabled={busy || sending} rows={3} onChange={(e) => setRequest(e.target.value)} placeholder='Ex.: "tira o corte em 2:13", "sem música", "põe o texto DICA DE OURO em 1:05", "thumbnail com o texto NÃO FAÇA ISSO"' />
          <button disabled={busy || sending || !request.trim()} onClick={() => void send()}>
            {sending ? "Entendendo o pedido…" : "Pedir correções"}
          </button>
          {reply && <p className="review-reply">{reply}</p>}

          <div className="decide">
            <select value="" disabled={busy} onChange={(e) => e.target.value && void act("redo", video.id, e.target.value)} title="Refazer uma etapa">
              <option value="">Refazer…</option>
              {stages.map((s) => (
                <option key={s.name} value={s.name}>
                  a partir de {s.label}
                </option>
              ))}
            </select>
            <div className="grow" />
            {video.status === "review" ? (
              <>
                <button disabled={busy} onClick={() => void act("reject", video.id)}>
                  Rejeitar
                </button>
                <button className="primary" disabled={busy || Boolean(video.data.dirty)} onClick={() => void act("approve", video.id)} title={video.data.dirty ? "Renderize as alterações antes de aprovar" : "Nada é publicado sem este clique"}>
                  Aprovar
                </button>
              </>
            ) : video.status === "approved" || video.status === "rejected" ? (
              <button onClick={() => void act("reopen", video.id)}>Voltar para a revisão</button>
            ) : null}
          </div>
          {video.status === "approved" && <p className="studio-hint">Aprovado em {new Date(video.approval?.approved_at ?? Date.now()).toLocaleString("pt-BR")}. O envio só aceita este arquivo e estes dados, exatamente como estão.</p>}
          {video.data.finalPath && <PublishBox video={video} busy={busy} />}
        </section>
      </div>

      <details className="script-logs">
        <summary>O que os agentes fizeram neste vídeo, e por quê</summary>
        <Logs videoId={video.id} />
      </details>
    </div>
  );
}

export function Review({ selected, onSelect }: { selected: number | null; onSelect: (id: number) => void }) {
  const videos = useStudio((s) => s.state!.videos);
  const ready = videos.filter((v) => v.data.kind !== "short" && (v.data.finalPath || v.status === "review"));
  const current = ready.find((v) => v.id === selected) ?? ready.find((v) => v.status === "review") ?? ready[0] ?? null;
  return (
    <div className="review">
      <aside>
        <h3>Vídeos</h3>
        <ul className="script-list">
          {ready.map((v) => (
            <li key={v.id} className={`${v.id === current?.id ? "active" : ""} sstatus-${v.status}`} onClick={() => onSelect(v.id)}>
              <b>{v.title}</b>
              <small>{v.status === "review" ? "Aguardando você" : v.status === "approved" ? "Aprovado" : v.status === "rejected" ? "Rejeitado" : "Processando"}</small>
            </li>
          ))}
          {!ready.length && <p className="studio-empty">Quando um vídeo terminar de ser processado ele aparece aqui.</p>}
        </ul>
      </aside>
      <div className="review-main">{current ? <Detail key={current.id} video={current} /> : <p className="studio-empty big">Nenhum vídeo para revisar ainda.</p>}</div>
    </div>
  );
}

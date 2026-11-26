import { useEffect, useState } from "react";
import { act, call, useStudio, type StudioVideo } from "./store";

const PRIVACY: Record<string, string> = { public: "Público", unlisted: "Não listado", private: "Privado" };

/** A timestamp as the value of an <input type="datetime-local">, in the computer's own time. */
export const localInput = (ms: number) => {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
};
export const when = (ms: number) => new Date(ms).toLocaleString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Title, description, tags and chapters as they will go to YouTube. Everything here is part of the approval. */
export function MetadataEditor({ video, busy }: { video: StudioVideo; busy: boolean }) {
  const categories = useStudio((s) => s.state!.categories);
  const meta = video.data.metadata;
  const sent = Boolean(video.data.youtube?.id);
  const locked = busy || sent;
  const [title, setTitle] = useState(meta?.title ?? "");
  const [body, setBody] = useState(meta?.body ?? "");
  const [tags, setTags] = useState((meta?.tags ?? []).join(", "));
  const [hashtags, setHashtags] = useState((meta?.hashtags ?? []).join(" "));
  useEffect(() => {
    setTitle(meta?.title ?? "");
    setBody(meta?.body ?? "");
    setTags((meta?.tags ?? []).join(", "));
    setHashtags((meta?.hashtags ?? []).join(" "));
  }, [video.id, meta?.title, meta?.body, (meta?.tags ?? []).join(","), (meta?.hashtags ?? []).join(",")]);
  const save = (patch: Record<string, unknown>) => void act("setMetadata", video.id, patch);
  const list = (text: string, split: RegExp) => text.split(split).map((t) => t.trim()).filter(Boolean);

  return (
    <>
      <h3>
        Título e descrição para o YouTube
        <button disabled={locked} onClick={() => void act("redoMetadata", video.id, false)} title="O agente de Metadados escreve novas sugestões. O que você digitou à mão é mantido.">
          {meta ? "Sugerir de novo" : "Gerar"}
        </button>
      </h3>
      {!meta && <p className="studio-empty">Ainda sem título e descrição. Clique em Gerar ou escreva abaixo.</p>}
      <label className="field">
        <span>Título ({title.length}/100)</span>
        <input value={title} maxLength={100} disabled={locked} onChange={(e) => setTitle(e.target.value)} onBlur={() => title.trim() && title.trim() !== (meta?.title ?? "") && save({ title })} />
      </label>
      {(meta?.titles ?? []).filter((t) => t !== meta?.title).length > 0 && (
        <ul className="title-options">
          {meta!.titles.filter((t) => t !== meta!.title).map((t) => (
            <li key={t}>
              <button disabled={locked} onClick={() => save({ title: t })} title="Usar este título">
                {t}
              </button>
            </li>
          ))}
        </ul>
      )}
      <label className="field">
        <span>Descrição (capítulos, créditos e hashtags são acrescentados sozinhos)</span>
        <textarea rows={6} value={body} disabled={locked} onChange={(e) => setBody(e.target.value)} onBlur={() => body !== (meta?.body ?? "") && save({ body })} />
      </label>
      <label className="field">
        <span>Tags, separadas por vírgula ({(meta?.tags ?? []).length})</span>
        <input value={tags} disabled={locked} onChange={(e) => setTags(e.target.value)} onBlur={() => tags !== (meta?.tags ?? []).join(", ") && save({ tags: list(tags, /,/) })} />
      </label>
      <div className="inline">
        <label className="field">
          <span>Hashtags (até 3)</span>
          <input value={hashtags} disabled={locked} onChange={(e) => setHashtags(e.target.value)} onBlur={() => hashtags !== (meta?.hashtags ?? []).join(" ") && save({ hashtags: list(hashtags, /[\s,#]+/).slice(0, 3) })} />
        </label>
        <label className="field">
          <span>Categoria</span>
          <select value={meta?.category ?? 22} disabled={locked} onChange={(e) => save({ category: Number(e.target.value) })}>
            {Object.entries(categories).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {(meta?.chapters ?? []).length > 0 && (
        <label className="toggle-row">
          <input type="checkbox" checked={meta!.useChapters !== false} disabled={locked} onChange={(e) => save({ useChapters: e.target.checked })} />
          <span>
            Capítulos na descrição ({meta!.chapterLines?.length ?? 0}
            {meta!.useChapters !== false && !(meta!.chapterLines ?? []).length ? ": o YouTube exige pelo menos 3" : ""})
          </span>
        </label>
      )}
      {meta?.description && (
        <details className="description-preview">
          <summary>Ver a descrição como vai para o YouTube</summary>
          <pre>{meta.description}</pre>
        </details>
      )}
      {meta?.notes && <p className="studio-hint">{meta.notes}</p>}
    </>
  );
}

/** When it goes out, and the button that sends it. The send button only exists for an approved video. */
export function PublishBox({ video, busy }: { video: StudioVideo; busy: boolean }) {
  const youtube = useStudio((s) => s.state!.youtube);
  const defaults = useStudio((s) => s.state!.settings.publish);
  const schedule = video.data.schedule ?? null;
  const publish = video.data.publish ?? null;
  const sent = video.data.youtube ?? null;
  const [at, setAt] = useState(schedule?.at ? localInput(schedule.at) : "");
  const [hint, setHint] = useState<string | null>(null);
  useEffect(() => setAt(schedule?.at ? localInput(schedule.at) : ""), [video.id, schedule?.at]);
  const sending = publish && ["queued", "uploading", "waiting"].includes(publish.status);
  const locked = busy || Boolean(sent) || Boolean(sending);

  const suggest = async () => {
    const out = (await act("suggestSchedule", video.id)) as { at: number | null; detail: string } | undefined;
    if (!out) return;
    setHint(out.detail);
    if (out.at) setAt(localInput(out.at));
  };
  const apply = () => void act("setSchedule", video.id, at ? { at: new Date(at).getTime() } : { at: null, privacy: schedule?.privacy ?? null });
  const changed = (at ? new Date(at).getTime() : null) !== (schedule?.at ?? null);

  if (sent)
    return (
      <>
        <h3>Publicação</h3>
        <p className="publish-done">
          Enviado ao YouTube em {when(sent.uploadedAt)}.{" "}
          {sent.publishAt && sent.publishAt > Date.now() ? `Fica privado até ${when(sent.publishAt)}, quando o YouTube publica sozinho.` : sent.privacy === "public" || sent.publishAt ? "Está público." : `Está como ${PRIVACY[sent.privacy].toLowerCase()}.`}
        </p>
        {typeof sent.thumbnail === "string" && <p className="card-error">A thumbnail não foi enviada: {sent.thumbnail}</p>}
        <div className="inline">
          <button onClick={() => void act("openLink", sent.url)}>Abrir no YouTube</button>
          <button onClick={() => void act("openLink", sent.studio)}>Abrir no YouTube Studio</button>
        </div>
        <p className="studio-hint">Mudanças depois do envio (título, data, thumbnail) são feitas no YouTube Studio.</p>
      </>
    );

  return (
    <>
      <h3>Publicação</h3>
      <div className="inline">
        <label className="field">
          <span>Publicar em</span>
          <input type="datetime-local" value={at} min={localInput(Date.now() + 20 * 60_000)} disabled={locked} onChange={(e) => setAt(e.target.value)} />
        </label>
        <button disabled={locked} onClick={() => void suggest()} title="Escolhe o melhor horário livre nas próximas duas semanas">
          Sugerir horário
        </button>
        {at && (
          <button disabled={locked} onClick={() => setAt("")} title="Sem data: vai ao ar assim que for enviado">
            Sem data
          </button>
        )}
        {changed && (
          <button className="primary" disabled={locked} onClick={apply}>
            Salvar data
          </button>
        )}
      </div>
      {!at && (
        <label className="field">
          <span>Sem data: assim que for enviado, o vídeo fica</span>
          <select value={schedule?.privacy ?? defaults.privacy} disabled={locked} onChange={(e) => void act("setSchedule", video.id, { at: null, privacy: e.target.value })}>
            {Object.entries(PRIVACY).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}
      {hint && <p className="studio-hint">{hint}</p>}
      {video.status === "approved" && !sending && <p className="studio-hint">Mudar a data, o título ou a thumbnail depois de aprovar pede uma nova aprovação.</p>}

      {publish && publish.status !== "done" && (
        <div className="card-progress">
          {(publish.status === "uploading" || publish.status === "queued") && (
            <>
              <div className="progress-bar">
                <div style={{ width: `${Math.round((publish.progress ?? 0) * 100)}%` }} />
              </div>
              <small>{publish.status === "queued" ? "Na fila de envio" : `Enviando ao YouTube: ${Math.round((publish.progress ?? 0) * 100)}%`}</small>
            </>
          )}
          {publish.status === "waiting" && (
            <small>
              {publish.error} Nova tentativa {publish.nextTry ? `em ${when(publish.nextTry)}` : "em breve"}, continuando de onde parou.
            </small>
          )}
          {publish.status === "stopped" && <small>Envio parado. Nada foi publicado.</small>}
          {publish.status === "error" && <p className="card-error">Não enviado: {publish.error}</p>}
        </div>
      )}

      <div className="decide">
        <div className="grow" />
        {sending ? (
          <button onClick={() => void act("cancelPublish", video.id)}>Parar o envio</button>
        ) : (
          <button
            className="primary"
            disabled={busy || video.status !== "approved" || !youtube.connected}
            onClick={() => void act("publish", video.id)}
            title={video.status !== "approved" ? "Aprove o vídeo antes: nada é enviado sem a sua aprovação" : !youtube.connected ? "Conecte o canal nas Configurações" : schedule?.at ? `Envia agora e o YouTube publica em ${when(schedule.at)}` : "Envia agora"}
          >
            {schedule?.at ? "Enviar e agendar no YouTube" : "Enviar ao YouTube"}
          </button>
        )}
      </div>
      {!youtube.connected && <p className="studio-hint">Para enviar, conecte o canal do YouTube nas Configurações.</p>}
      {youtube.connected && video.status !== "approved" && <p className="studio-hint">O botão de envio só funciona depois de você aprovar o vídeo, com estes dados exatos.</p>}
    </>
  );
}

/** Used by the calendar: asks before a change that costs an approval. */
export async function reschedule(video: StudioVideo, at: number) {
  if (video.data.youtube?.id) {
    useStudio.setState({ error: "Este vídeo já está no YouTube. Mude a data dele pelo YouTube Studio." });
    return;
  }
  if (video.status === "approved" && !confirm(`"${video.title}" já foi aprovado. Mudar a data volta o vídeo para a revisão, para você aprovar de novo. Mudar?`)) return;
  await act("setSchedule", video.id, { at });
}

export { call };

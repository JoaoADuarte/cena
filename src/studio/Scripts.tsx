import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/controls";
import { Logs } from "./Logs";
import { act, call, clock, useStudio, type ScriptContent, type StudioScript } from "./store";

const TONES = ["engraçado", "emocionante", "inspirador", "polêmico", "educativo", "suspense"];

const STATUS: Record<StudioScript["status"], string> = {
  queued: "Na fila",
  researching: "Pesquisando o tema",
  writing: "Escrevendo",
  review: "Aguardando você",
  approved: "Aprovado para gravar",
  rejected: "Rejeitado",
  error: "Erro",
};

function NewScript({ onCreated }: { onCreated: (id: number) => void }) {
  const [topic, setTopic] = useState("");
  const [tone, setTone] = useState("");
  const [minutes, setMinutes] = useState(8);
  const [format, setFormat] = useState<"long" | "short">("long");
  const addTone = (t: string) => setTone((cur) => (cur.includes(t) ? cur : cur ? `${cur}, ${t}` : t));
  const create = async () => {
    const id = (await act("createScript", { topic, tone, durationTarget: format === "short" ? Math.min(60, minutes * 60) : minutes * 60, format })) as number | undefined;
    if (id) {
      setTopic("");
      onCreated(id);
    }
  };
  return (
    <div className="new-script">
      <h3>Novo roteiro</h3>
      <label className="field">
        <span>Tema</span>
        <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Ex.: como automatizei minha base inteira no Satisfactory" />
      </label>
      <label className="field">
        <span>Tom (pode misturar: "70% engraçado, 30% emoção")</span>
        <input value={tone} onChange={(e) => setTone(e.target.value)} placeholder="engraçado, com um final emocionante" />
        <div className="chips">
          {TONES.map((t) => (
            <button key={t} type="button" onClick={() => addTone(t)}>
              {t}
            </button>
          ))}
        </div>
      </label>
      <div className="inline">
        <label className="field">
          <span>Formato</span>
          <select
            value={format}
            onChange={(e) => {
              const f = e.target.value as "long" | "short";
              setFormat(f);
              setMinutes(f === "short" ? 1 : 8);
            }}
          >
            <option value="long">Vídeo longo</option>
            <option value="short">Short (até 60 s)</option>
          </select>
        </label>
        {format === "long" && (
          <label className="field">
            <span>Duração (minutos)</span>
            <input type="number" min={1} max={120} value={minutes} onChange={(e) => setMinutes(Math.max(1, Number(e.target.value) || 1))} />
          </label>
        )}
      </div>
      <button className="primary" disabled={!topic.trim()} onClick={() => void create()}>
        <Icon name="sparkle" /> Pesquisar e escrever
      </button>
    </div>
  );
}

/** Full-window reading view: clean text, big letters, steady scroll at the creator's own pace. */
function Teleprompter({ scriptId, onClose }: { scriptId: number; onClose: () => void }) {
  const [data, setData] = useState<{ topic: string; text: string; wpm: number } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [size, setSize] = useState(54);
  const [mirror, setMirror] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void call<typeof data>("teleprompter", scriptId).then(setData);
  }, [scriptId]);

  useEffect(() => {
    if (!playing || !data) return;
    const el = scroller.current!;
    const words = (data.text.match(/\S+/g) ?? []).length;
    // The whole text passes in the time it takes to say it.
    const pxPerSecond = (text.current!.scrollHeight / Math.max(1, (words / data.wpm) * 60)) * speed;
    let last = performance.now();
    let position = el.scrollTop;
    let frame = 0;
    const step = (now: number) => {
      position += ((now - last) / 1000) * pxPerSecond;
      last = now;
      el.scrollTop = position;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) setPlaying(false);
      else frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, size, data]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === "Escape") onClose();
      else if (e.key === "ArrowUp") setSpeed((s) => Math.min(3, +(s + 0.1).toFixed(1)));
      else if (e.key === "ArrowDown") setSpeed((s) => Math.max(0.3, +(s - 0.1).toFixed(1)));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  if (!data) return null;
  return (
    <div className="teleprompter">
      <div className="tp-bar">
        <button className="primary" onClick={() => setPlaying(!playing)} title="Espaço">
          <Icon name={playing ? "pause" : "play"} /> {playing ? "Pausar" : "Rolar"}
        </button>
        <button onClick={() => ((scroller.current!.scrollTop = 0), setPlaying(false))}>Do início</button>
        <label>
          Velocidade
          <input type="range" min={0.3} max={3} step={0.1} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
          <b>{speed.toFixed(1).replace(".", ",")}x</b>
        </label>
        <label>
          Letra
          <input type="range" min={28} max={110} step={2} value={size} onChange={(e) => setSize(Number(e.target.value))} />
        </label>
        <label className="toggle-row">
          <input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} />
          <span>Espelhar (para vidro de teleprompter)</span>
        </label>
        <div className="grow" />
        <span className="studio-hint">Espaço rola e pausa · ↑ ↓ mudam a velocidade · Esc fecha</span>
        <button onClick={onClose}>
          <Icon name="close" /> Fechar
        </button>
      </div>
      <div className="tp-scroll" ref={scroller} onClick={() => setPlaying(!playing)}>
        <div className="tp-line" />
        <div className="tp-text" ref={text} style={{ fontSize: size, transform: mirror ? "scaleX(-1)" : undefined }}>
          {data.text.split(/\n{2,}/).map((paragraph, i) => (
            <p key={i}>{paragraph}</p>
          ))}
        </div>
      </div>
    </div>
  );
}

function Editor({ script }: { script: StudioScript }) {
  const [draft, setDraft] = useState<ScriptContent | null>(script.content);
  const [instruction, setInstruction] = useState("");
  const [prompting, setPrompting] = useState(false);
  const [versions, setVersions] = useState<{ version: number; instruction: string | null; created_at: number }[]>([]);
  const tick = useStudio((s) => s.tick);
  const busy = script.status === "queued" || script.status === "researching" || script.status === "writing";

  // A new version from the agent replaces what is on screen; typing is kept until then.
  useEffect(() => setDraft(script.content), [script.id, script.version]);
  useEffect(() => {
    void call<typeof versions>("scriptVersions", script.id).then(setVersions);
  }, [script.id, script.version, tick]);

  const changed = draft && script.content && JSON.stringify({ ...draft, hook: 0 }) !== JSON.stringify({ ...script.content, hook: 0 });
  const patch = (p: Partial<ScriptContent>) => setDraft((d) => (d ? { ...d, ...p } : d));

  return (
    <div className="script-editor">
      <header>
        <div>
          <h2>{script.topic}</h2>
          <small>
            {STATUS[script.status]} · tom: {script.tone} · alvo {clock(script.duration_target)}
            {script.content ? ` · estimado ${clock(script.content.estimated_seconds)}` : ""} · {script.format === "short" ? "Short" : "vídeo longo"}
            {script.version ? ` · versão ${script.version}` : ""}
          </small>
        </div>
        <div className="grow" />
        {script.content && (
          <button onClick={() => setPrompting(true)} title="Texto limpo e grande para gravar">
            <Icon name="text" /> Teleprompter
          </button>
        )}
        <button className="danger-btn" onClick={() => confirm("Apagar este roteiro?") && void act("removeScript", script.id)} title="Apagar roteiro">
          <Icon name="trash" />
        </button>
      </header>

      {busy && (
        <div className="studio-working">
          <span className="spinner" /> {script.pending_instruction ? `Ajustando: "${script.pending_instruction}"` : STATUS[script.status]}…
        </div>
      )}
      {script.error && <p className="card-error">{script.error}</p>}

      {script.research && (
        <details className="research">
          <summary>
            Pesquisa do tema{script.research.source === "api" ? " · números da API do YouTube" : " · busca na web"}{script.research.confidence ? ` · confiança ${script.research.confidence}` : ""} · {script.research.references?.length ?? 0} referências
          </summary>
          <p>{script.research.summary}</p>
          {script.research.limits && <p className="studio-hint">Limites: {script.research.limits}</p>}
          <ul>
            {(script.research.references ?? []).map((r, i) => (
              <li key={i}>
                {r.url ? (
                  <a href="#" onClick={(e) => (e.preventDefault(), void window.api.openExternal(r.url!))}>
                    {r.title}
                  </a>
                ) : (
                  <b>{r.title}</b>
                )}
                {r.channel ? ` · ${r.channel}` : ""}
                {r.views ? ` · ${r.views.toLocaleString("pt-BR")} views` : ""}
                {r.views_per_day != null ? ` · ${Math.round(r.views_per_day).toLocaleString("pt-BR")}/dia` : ""}
                {r.views_per_subscriber != null ? ` · ${r.views_per_subscriber.toLocaleString("pt-BR")} views por inscrito` : ""}
                {r.engagement != null ? ` · engajamento ${(r.engagement * 100).toFixed(1)}%` : ""}
                {r.verified ? <b className="verified" title="Números lidos da API do YouTube"> ✓ verificado</b> : script.research!.source === "api" ? <small title="O agente citou, mas a API não confirmou os números"> · não verificado</small> : null}
                {r.why_it_worked ? <small> — {r.why_it_worked}</small> : null}
              </li>
            ))}
          </ul>
        </details>
      )}

      {draft && (
        <>
          <section>
            <h3>Gancho (primeiros 5 a 15 segundos): escolha um</h3>
            <div className="hooks">
              {draft.hooks.map((hook, i) => (
                <label key={i} className={`hook${(script.content?.hook ?? 0) === i ? " chosen" : ""}`}>
                  <input type="radio" name={`hook-${script.id}`} checked={(script.content?.hook ?? 0) === i} onChange={() => void act("chooseHook", script.id, i)} />
                  <textarea value={hook} rows={3} onChange={(e) => patch({ hooks: draft.hooks.map((h, j) => (j === i ? e.target.value : h)) })} />
                </label>
              ))}
            </div>
          </section>
          <section>
            <h3>Roteiro</h3>
            <textarea className="script-body" value={draft.body} onChange={(e) => patch({ body: e.target.value })} spellCheck={false} />
            <p className="studio-hint">Marcações entre colchetes ([PAUSA], [B-ROLL: …], [MÚSICA: …]) orientam a edição e não aparecem no teleprompter.</p>
          </section>
          <div className="script-columns">
            <section>
              <h3>Pontos de retenção</h3>
              <ul className="retention">
                {draft.retention.map((r, i) => (
                  <li key={i}>
                    <b>{r.at}</b> {r.text}
                  </li>
                ))}
              </ul>
            </section>
            <section>
              <h3>Chamada final (CTA)</h3>
              <textarea value={draft.cta} rows={3} onChange={(e) => patch({ cta: e.target.value })} />
              <h3>Ideias de título</h3>
              <ul className="retention">
                {draft.titles.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </section>
          </div>
          {draft.notes && <p className="studio-hint">Nota do agente: {draft.notes}</p>}

          <section className="script-actions">
            <div className="adjust">
              <input value={instruction} disabled={busy} onChange={(e) => setInstruction(e.target.value)} placeholder='Peça um ajuste: "mais piadas no meio", "final mais emocionante", "corta 1 minuto"' onKeyDown={(e) => e.key === "Enter" && instruction.trim() && (void act("adjustScript", script.id, instruction), setInstruction(""))} />
              <button disabled={busy || !instruction.trim()} onClick={() => (void act("adjustScript", script.id, instruction), setInstruction(""))}>
                Pedir ajuste
              </button>
            </div>
            <div className="decide">
              {changed && (
                <button onClick={() => void act("saveScript", script.id, draft)} title="Guarda o que você digitou como uma nova versão">
                  <Icon name="save" /> Salvar minha edição
                </button>
              )}
              {versions.length > 1 && (
                <select value="" onChange={(e) => e.target.value && confirm(`Voltar para a versão ${e.target.value}?`) && void act("restoreScript", script.id, Number(e.target.value))} title="Versões anteriores">
                  <option value="">Versões…</option>
                  {versions.map((v) => (
                    <option key={v.version} value={v.version}>
                      {v.version} · {v.instruction ?? "primeira"} · {new Date(v.created_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                    </option>
                  ))}
                </select>
              )}
              <div className="grow" />
              {script.status !== "rejected" && (
                <button disabled={busy} onClick={() => void act("rejectScript", script.id)}>
                  Rejeitar
                </button>
              )}
              <button className="primary" disabled={busy || Boolean(changed) || script.status === "approved"} onClick={() => void act("approveScript", script.id)} title={changed ? "Salve a sua edição antes de aprovar" : "Libera o roteiro para gravação"}>
                {script.status === "approved" ? "Aprovado" : "Aprovar roteiro"}
              </button>
            </div>
          </section>
        </>
      )}

      <details className="script-logs">
        <summary>O que os agentes fizeram neste roteiro</summary>
        <Logs scriptId={script.id} />
      </details>
      {prompting && <Teleprompter scriptId={script.id} onClose={() => setPrompting(false)} />}
    </div>
  );
}

export function Scripts() {
  const scripts = useStudio((s) => s.state!.scripts);
  const [selected, setSelected] = useState<number | null>(null);
  const current = scripts.find((s) => s.id === selected) ?? null;
  return (
    <div className="scripts">
      <aside>
        <NewScript onCreated={setSelected} />
        <h3>Roteiros</h3>
        <ul className="script-list">
          {scripts.map((s) => (
            <li key={s.id} className={`${s.id === selected ? "active" : ""} sstatus-${s.status}`} onClick={() => setSelected(s.id)}>
              <b>{s.topic}</b>
              <small>{STATUS[s.status]}</small>
            </li>
          ))}
          {!scripts.length && <p className="studio-empty">Nenhum roteiro ainda.</p>}
        </ul>
      </aside>
      <div className="scripts-main">{current ? <Editor key={current.id} script={current} /> : <p className="studio-empty big">Crie um roteiro ou escolha um na lista.</p>}</div>
    </div>
  );
}

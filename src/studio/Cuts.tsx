import { useEffect, useMemo, useRef, useState } from "react";
import { mediaUrl } from "../engine/mediaPool";
import { act, call, clock, useStudio, type Cut, type Part, type StudioVideo } from "./store";

/**
 * How much happens on screen along the recording (movement and game sound, measured, no AI): taller and warmer is
 * more action, grey is a still screen. Cuts over strong action are held back unless you turn them on.
 */
function ActionStrip({ action, duration, now, seek }: { action: NonNullable<StudioVideo["data"]["action"]>; duration: number; now: number; seek: (t: number) => void }) {
  const total = Math.max(1, duration);
  return (
    <div
      className="action-strip"
      title="Ação na tela e no som do jogo (medida no seu PC). Cortes em cima de ação forte ficam desligados até você ligar. Clique para ir até o ponto."
      onClick={(e) => seek(((e.clientX - e.currentTarget.getBoundingClientRect().left) / e.currentTarget.clientWidth) * duration)}
    >
      {action.still.map((r, i) => (
        <u key={`s${i}`} style={{ left: `${(r.start / total) * 100}%`, width: `${((r.end - r.start) / total) * 100}%` }} />
      ))}
      {action.strip.map((v, i) => (
        <i key={i} style={{ left: `${((i * action.every) / total) * 100}%`, width: `${(action.every / total) * 100}%`, height: `${Math.round(15 + 85 * v)}%`, background: v >= 0.75 ? "#e0683a" : v >= 0.5 ? "#c9a23a" : "#4f6b5c" }} />
      ))}
      <b style={{ left: `${(now / total) * 100}%` }} />
      <span>ação</span>
    </div>
  );
}

const KIND_COLOR: Record<string, string> = {
  silêncio: "#4a6fa5",
  hesitação: "#7a6aa8",
  gaguejo: "#8b6f47",
  parado: "#5d7d6a",
  "sem fala": "#55606e",
  "take repetido": "#a8663d",
  erro: "#a84848",
  enrolação: "#9a7b2f",
  pedido: "#c2507e",
  manual: "#d07a2c",
};

const message = (err: unknown) => (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** "1:02:30", "12:05", "75" or "75,5" → seconds. */
function seconds(text: string): number | null {
  const parts = text.trim().replace(",", ".").split(":").map((p) => p.trim());
  if (!parts.length || parts.some((p) => p === "" || !Number.isFinite(Number(p)))) return null;
  return parts.reduce((sum, p) => sum * 60 + Number(p), 0);
}
const stamp = (s: number) => `${clock(Math.floor(s))}${s % 1 ? `,${Math.round((s % 1) * 10)}` : ""}`;

function merged(cuts: Cut[]) {
  const out: { start: number; end: number }[] = [];
  for (const c of cuts.filter((x) => x.enabled).sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && c.start <= last.end) last.end = Math.max(last.end, c.end);
    else out.push({ start: c.start, end: c.end });
  }
  return out;
}

/** Where a video that was through the Cut agent can have its cuts changed. */
export const hasCuts = (v: StudioVideo) => v.data.kind !== "short" && v.stages.find((s) => s.name === "cut")?.status === "done" && Array.isArray(v.data.cuts);

function AskCuts({ video }: { video: StudioVideo }) {
  const claude = useStudio((s) => s.state!.claude);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [talk, setTalk] = useState<{ who: "you" | "agent" | "error"; text: string }[]>([]);
  useEffect(() => setTalk([]), [video.id]);
  const send = async () => {
    const request = text.trim();
    if (!request || busy) return;
    setBusy(true);
    setTalk((t) => [...t, { who: "you", text: request }]);
    setText("");
    try {
      const out = await call<{ reply: string; applied: string[]; before: number; after: number }>("askCuts", video.id, request);
      setTalk((t) => [...t, { who: "agent", text: `${out.reply}${out.applied.length ? ` O vídeo vai de ${clock(out.before)} para ${clock(out.after)}.` : ""}` }]);
    } catch (err) {
      setTalk((t) => [...t, { who: "error", text: message(err) }]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside className="shorts-ask">
      <h3>Dizer o que cortar</h3>
      <div className="shorts-talk">
        {!talk.length && (
          <p className="studio-hint">
            Exemplos: "corta do minuto 10 ao 25", "deixa só de 5:00 até 48:30", "quero o vídeo com uns 20 minutos, só as melhores partes", "tira a parte em que eu fico no menu", "não corta nada do começo até 1:30", "liga todos os trechos sem fala". O agente lê o que foi falado e sabe onde há ação e tela parada (medidos no seu PC).
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
        disabled={busy || !claude}
        placeholder={claude ? "Escreva o que cortar ou manter" : "Precisa do Claude Code instalado"}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <button className="primary" disabled={busy || !text.trim() || !claude} onClick={() => void send()}>
        Enviar
      </button>
    </aside>
  );
}

type PartRow = { title: string; reason: string; start: string; end: string };
const toRows = (parts: Part[]): PartRow[] => parts.map((p) => ({ title: p.title, reason: p.reason, start: stamp(p.start), end: stamp(p.end) }));

/** One recording, several videos: the parts the Director proposed, to check, change and turn into videos. */
function Parts({ video, seek, now }: { video: StudioVideo; seek: (t: number) => void; now: number }) {
  const claude = useStudio((s) => s.state!.claude);
  const [rows, setRows] = useState<PartRow[]>(() => toRows(video.data.parts ?? []));
  const [edited, setEdited] = useState(false);
  const [ask, setAsk] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    setRows(toRows(video.data.parts ?? []));
    setEdited(false);
  }, [video.id, video.data.parts]);
  const out = useMemo(() => merged(video.data.cuts ?? []), [video.data.cuts]);
  const parsed = rows.map((r) => ({ title: r.title, reason: r.reason, start: seconds(r.start), end: seconds(r.end) }));
  const valid = parsed.length > 0 && parsed.every((p) => p.start !== null && p.end !== null && p.end - p.start >= 20);
  /** How long a part ends up, with the cuts inside it. */
  const lengthOf = (p: { start: number | null; end: number | null }) => {
    if (p.start === null || p.end === null) return 0;
    const cut = out.reduce((sum, c) => sum + Math.max(0, Math.min(p.end!, c.end) - Math.max(p.start!, c.start)), 0);
    return Math.max(0, p.end - p.start - cut);
  };
  const change = (i: number, patch: Partial<PartRow>) => {
    setRows((list) => list.map((r, k) => (k === i ? { ...r, ...patch } : r)));
    setEdited(true);
  };
  const run = async (label: string, work: () => Promise<string | null | void>) => {
    setBusy(label);
    setNote(null);
    useStudio.setState({ error: null });
    try {
      const said = await work();
      if (said) setNote(said);
    } catch (err) {
      useStudio.setState({ error: message(err) });
    } finally {
      setBusy(null);
    }
  };
  const save = () => call<Part[]>("setParts", video.id, parsed);

  return (
    <section className="parts-panel">
      <header>
        <h4>Vídeos desta gravação ({rows.length})</h4>
        {video.data.partsReply && <span className="studio-hint">Diretor: {video.data.partsReply}</span>}
      </header>
      <ul>
        {rows.map((r, i) => (
          <li key={i}>
            <b>{i + 1}</b>
            <input className="part-title" value={r.title} onChange={(e) => change(i, { title: e.target.value })} />
            <input className="part-time" value={r.start} onChange={(e) => change(i, { start: e.target.value })} title="Início, na gravação" />
            <button onClick={() => change(i, { start: stamp(Math.round(now * 10) / 10) })} title="Usar o ponto em que o vídeo está">
              agora
            </button>
            <span>–</span>
            <input className="part-time" value={r.end} onChange={(e) => change(i, { end: e.target.value })} title="Fim, na gravação" />
            <button onClick={() => change(i, { end: stamp(Math.round(now * 10) / 10) })} title="Usar o ponto em que o vídeo está">
              agora
            </button>
            <span className="part-length" title="Duração com os cortes">
              {clock(lengthOf(parsed[i]))}
            </span>
            <button onClick={() => parsed[i].start !== null && seek(parsed[i].start!)} title="Ver o começo desta parte">
              Ver
            </button>
            <button
              className="danger-btn"
              title="Tirar esta parte"
              onClick={() => {
                setRows((list) => list.filter((_, k) => k !== i));
                setEdited(true);
              }}
            >
              ×
            </button>
            {r.reason && <small>{r.reason}</small>}
          </li>
        ))}
      </ul>
      <div className="inline">
        <button
          onClick={() => {
            const last = parsed[parsed.length - 1];
            const from = Math.max(now, last?.end ?? 0);
            setRows((list) => [...list, { title: `Parte ${list.length + 1}`, reason: "", start: stamp(Math.round(from)), end: stamp(Math.round(Math.min(video.data.duration ?? from + 60, from + 600))) }]);
            setEdited(true);
          }}
        >
          + Parte
        </button>
        {edited && (
          <button disabled={!valid || Boolean(busy)} onClick={() => void run("save", async () => (await save(), "Partes salvas."))}>
            Salvar mudanças
          </button>
        )}
        <span className="grow" />
        <button
          onClick={() => confirm("Seguir com a gravação inteira como um vídeo só, sem dividir?") && void run("one", async () => (await call("continueVideo", video.id), "O fluxo segue com um vídeo só."))}
          disabled={Boolean(busy)}
        >
          Seguir como um vídeo só
        </button>
        <button
          className="primary"
          disabled={!valid || Boolean(busy)}
          onClick={() =>
            void run("make", async () => {
              if (edited) await save();
              const ids = await call<number[]>("makeParts", video.id);
              return `${ids.length} vídeos criados. Cada um segue da Edição em diante no Painel.`;
            })
          }
        >
          {busy === "make" ? "Criando…" : `Criar os ${rows.length} vídeos`}
        </button>
      </div>
      {!valid && <p className="studio-hint">Cada parte precisa de início e fim (como 12:05 ou 1:02:30) e pelo menos 20 segundos.</p>}
      <div className="inline ask-parts">
        <input value={ask} placeholder='Ex.: "faz 3 vídeos em vez de 4" ou "a parte 2 começa no 25:10"' onChange={(e) => setAsk(e.target.value)} disabled={!claude || Boolean(busy)} />
        <button
          disabled={!claude || Boolean(busy) || !ask.trim()}
          onClick={() =>
            void run("ask", async () => {
              const got = await call<{ reply: string }>("askParts", video.id, ask.trim());
              setAsk("");
              return got.reply || "Partes refeitas.";
            })
          }
        >
          {busy === "ask" ? "O Diretor está olhando…" : "Pedir ao Diretor"}
        </button>
      </div>
      {note && <p className="cuts-note">{note}</p>}
    </section>
  );
}

function Editor({ video }: { video: StudioVideo }) {
  const stages = useStudio((s) => s.state!.stages);
  const working = useStudio((s) => s.state!.agents.some((a) => a.status === "running" && a.id !== "publish")) && video.status === "running";
  const player = useRef<HTMLVideoElement>(null);
  const [skip, setSkip] = useState(true);
  const [now, setNow] = useState(0);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [why, setWhy] = useState("");
  const [filter, setFilter] = useState<"big" | "on" | "off" | "all">("big");
  const [shown, setShown] = useState(200);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const cuts = useMemo(() => video.data.cuts ?? [], [video.data.cuts]);
  const duration = video.data.duration ?? 0;
  const out = useMemo(() => merged(cuts), [cuts]);
  const removed = out.reduce((sum, c) => sum + c.end - c.start, 0);
  const on = cuts.filter((c) => c.enabled);
  const locked = video.status === "running" || video.status === "divided";
  const splitting = video.status === "hold" && video.data.hold?.after === "split" && Boolean(video.data.parts?.length) && !video.data.children?.length;

  useEffect(() => {
    setNote(null);
    setFrom("");
    setTo("");
    setShown(200);
  }, [video.id]);

  // Playing "as it will be": the player jumps over every stretch that is cut.
  useEffect(() => {
    let frame = 0;
    const watch = () => {
      const el = player.current;
      if (el) {
        const t = el.currentTime;
        if (skip && !el.paused) {
          const inside = out.find((c) => t >= c.start && t < c.end - 0.03);
          if (inside) el.currentTime = Math.min(duration, inside.end);
        }
        setNow((before) => (Math.abs(before - t) > 0.2 ? t : before));
      }
      frame = requestAnimationFrame(watch);
    };
    frame = requestAnimationFrame(watch);
    return () => cancelAnimationFrame(frame);
  }, [skip, out, duration]);

  const seek = (t: number) => {
    if (player.current) player.current.currentTime = Math.max(0, Math.min(duration, t));
  };
  const run = async (label: string, work: () => Promise<string | null | void>) => {
    setBusy(label);
    setNote(null);
    useStudio.setState({ error: null });
    try {
      const said = await work();
      if (said) setNote(said);
    } catch (err) {
      useStudio.setState({ error: message(err) });
    } finally {
      setBusy(null);
    }
  };
  const addCut = () => {
    const a = seconds(from);
    const b = seconds(to);
    if (a === null || b === null) return useStudio.setState({ error: "Escreva o início e o fim como 12:05 ou 1:02:30." });
    void run("cut", async () => {
      const res = await call<{ duration: number }>("addCut", video.id, { start: a, end: b, reason: why });
      setFrom("");
      setTo("");
      setWhy("");
      return `Trecho cortado. O vídeo fica com ${clock(res.duration)}.`;
    });
  };
  const goOn = () =>
    run("continue", async () => {
      try {
        const got = await call<{ changed: boolean; manual?: number; duration: number } | null>("continueVideo", video.id);
        return got?.changed ? `Cortes do editor aproveitados (${got.manual} novos). O fluxo continua com ${clock(got.duration)}.` : "O fluxo continua.";
      } catch (err) {
        if (!confirm(`${message(err)}\n\nContinuar mesmo assim, sem as mudanças feitas no editor?`)) return null;
        await call("continueVideo", video.id, { ignoreEditor: true });
        return "O fluxo continua, sem as mudanças do editor.";
      }
    });

  const stopAfter = video.data.hold ? (stages.find((s) => s.name === video.data.hold!.after)?.label ?? video.data.hold.after) : null;
  const kinds = [...new Set(cuts.map((c) => c.kind))];
  const listed = cuts.filter((c) => (filter === "all" ? true : filter === "on" ? c.enabled : filter === "off" ? !c.enabled : c.end - c.start >= 5 || c.kind === "manual" || c.kind === "pedido"));

  return (
    <div className="cuts-main">
      <div className={`cuts-state state-${video.status}`}>
        {splitting && (
          <span>
            <b>O Diretor propôs {video.data.parts!.length} vídeos a partir desta gravação.</b> Confira as partes abaixo, mude o que quiser e clique em Criar os vídeos. Os cortes valem para todas as partes.
          </span>
        )}
        {video.status === "divided" && (
          <span>
            <b>Esta gravação virou {video.data.children?.length ?? 0} vídeos.</b> Os cortes de cada um estão no próprio vídeo, na lista à esquerda.
          </span>
        )}
        {video.status === "hold" && !splitting && (
          <>
            <span>
              <b>O fluxo está parado depois de {stopAfter}.</b> Ajuste os cortes e clique em Continuar: Áudio, Edição, Thumbnail e Montagem seguem com o vídeo como ele estiver.
            </span>
            <button className="primary" disabled={Boolean(busy)} onClick={() => void goOn()}>
              {busy === "continue" ? "Continuando…" : "Continuar o fluxo"}
            </button>
          </>
        )}
        {video.status === "paused" && (
          <>
            <span>
              <b>Vídeo pausado por você.</b> Ajuste os cortes e clique em Continuar.
            </span>
            <button className="primary" disabled={Boolean(busy)} onClick={() => void goOn()}>
              Continuar o fluxo
            </button>
          </>
        )}
        {(video.status === "running" || video.status === "queued") && (
          <>
            <span>{working || locked ? "Os agentes estão trabalhando neste vídeo. Pause-o para mexer nos cortes." : "Este vídeo está na fila. Pause-o se quiser mexer nos cortes com calma."}</span>
            <button onClick={() => void act("pauseVideo", video.id)}>Pausar este vídeo</button>
          </>
        )}
        {(video.status === "review" || video.status === "approved") && (
          <>
            <span>{video.data.dirty ? <b>Os cortes mudaram depois da montagem.</b> : "Este vídeo já foi montado. Se você mudar os cortes, ele precisa ser montado de novo."}</span>
            {video.data.dirty && (
              <button className="primary" onClick={() => void act("redo", video.id, "assemble")}>
                Montar de novo
              </button>
            )}
          </>
        )}
        {video.status === "error" && <span>Este vídeo parou com erro: {video.error}</span>}
      </div>

      {splitting && <Parts video={video} seek={seek} now={now} />}

      <div className="cuts-top">
        <div className="cuts-player">
          <video ref={player} src={mediaUrl(video.source_path)} controls preload="metadata" />
          <div className="cut-strip" title="A gravação inteira: em cor, o que sai. Clique para ir até o ponto." onClick={(e) => seek(((e.clientX - e.currentTarget.getBoundingClientRect().left) / e.currentTarget.clientWidth) * duration)}>
            {cuts.map((c) => (
              <i key={c.id} className={c.enabled ? "on" : "off"} style={{ left: `${(c.start / duration) * 100}%`, width: `${Math.max(0.05, ((c.end - c.start) / duration) * 100)}%`, background: c.enabled ? (KIND_COLOR[c.kind] ?? "#a84848") : undefined }} />
            ))}
            <b style={{ left: `${(now / Math.max(1, duration)) * 100}%` }} />
          </div>
          {video.data.action && <ActionStrip action={video.data.action} duration={duration} now={now} seek={seek} />}
          <label className="toggle-row">
            <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
            <span>Tocar pulando o que está cortado (como o vídeo vai ficar)</span>
          </label>
        </div>

        <div className="cuts-side">
          <p className="cuts-numbers">
            Gravação: <b>{clock(duration)}</b> · fica com <b>{clock(duration - removed)}</b>
            <br />
            {on.length} cortes ligados tiram {clock(removed)} · {cuts.length - on.length} sugestões desligadas
          </p>
          <div className="cuts-form">
            <h4>Cortar um trecho</h4>
            <div className="inline">
              <label className="field">
                <span>Início</span>
                <input value={from} placeholder="12:05" onChange={(e) => setFrom(e.target.value)} disabled={locked} />
              </label>
              <button onClick={() => setFrom(stamp(Math.round(now * 10) / 10))} disabled={locked} title="Usa o ponto em que o vídeo está">
                agora
              </button>
              <label className="field">
                <span>Fim</span>
                <input value={to} placeholder="25:40" onChange={(e) => setTo(e.target.value)} disabled={locked} />
              </label>
              <button onClick={() => setTo(stamp(Math.round(now * 10) / 10))} disabled={locked} title="Usa o ponto em que o vídeo está">
                agora
              </button>
            </div>
            <label className="field">
              <span>Motivo (opcional)</span>
              <input value={why} onChange={(e) => setWhy(e.target.value)} disabled={locked} />
            </label>
            <button className="primary" disabled={locked || Boolean(busy) || !from.trim() || !to.trim()} onClick={addCut}>
              Cortar este trecho
            </button>
          </div>
          <div className="cuts-form">
            <h4>Cortar no editor do Cena</h4>
            <p className="studio-hint">Abre a gravação no editor com os cortes já feitos. Corte lá à vontade, salve (Ctrl+S) e volte: o Estúdio aproveita os cortes. Efeitos, textos e trocas de ordem ficam para a revisão final.</p>
            <div className="inline">
              <button disabled={locked || Boolean(busy)} onClick={() => void run("editor", async () => void (await call("openCutsInEditor", video.id)))}>
                {busy === "editor" ? "Preparando o projeto…" : "Abrir no editor"}
              </button>
              {video.data.cutProject && (
                <button
                  disabled={locked || Boolean(busy)}
                  onClick={() =>
                    void run("import", async () => {
                      const got = await call<{ changed: boolean; manual?: number; restored?: number; duration: number }>("importEditorCuts", video.id);
                      return got.changed ? `${got.manual} cortes trazidos do editor${got.restored ? `, ${got.restored} desfeitos` : ""}. O vídeo fica com ${clock(got.duration)}.` : "O projeto do editor não tem cortes novos (lembre de salvar com Ctrl+S).";
                    })
                  }
                >
                  Trazer os cortes do editor
                </button>
              )}
            </div>
          </div>
          {note && <p className="cuts-note">{note}</p>}
        </div>
      </div>

      <section className="cuts-list">
        <header>
          <h4>Cortes</h4>
          <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            <option value="big">os maiores e os seus ({cuts.filter((c) => c.end - c.start >= 5 || c.kind === "manual" || c.kind === "pedido").length})</option>
            <option value="on">ligados ({on.length})</option>
            <option value="off">sugestões desligadas ({cuts.length - on.length})</option>
            <option value="all">todos ({cuts.length})</option>
          </select>
          <span className="grow" />
          {kinds.map((kind) => {
            const all = cuts.filter((c) => c.kind === kind);
            const active = all.filter((c) => c.enabled).length;
            return (
              <button key={kind} className="kind-chip" disabled={locked} style={{ borderColor: KIND_COLOR[kind] ?? "#555" }} title={active ? `Desligar os ${active} cortes "${kind}"` : `Ligar os ${all.length} cortes "${kind}"`} onClick={() => void act("setCutKind", video.id, kind, !active)}>
                {kind} {active}/{all.length}
              </button>
            );
          })}
        </header>
        <ul>
          {listed.slice(0, shown).map((c) => (
            <li key={c.id} className={c.enabled ? "" : "off"}>
              <input type="checkbox" checked={c.enabled} disabled={locked} onChange={(e) => void act("setCut", video.id, c.id, e.target.checked)} title={c.enabled ? "Ligado: este trecho sai do vídeo" : "Desligado: este trecho fica"} />
              <button className="cut-time" onClick={() => seek(c.start - 2)} title="Ver este ponto">
                {clock(c.start)}–{clock(c.end)}
              </button>
              <span className="cut-kind" style={{ background: KIND_COLOR[c.kind] ?? "#555" }}>
                {c.kind}
              </span>
              <span className="cut-length">{c.end - c.start >= 90 ? clock(c.end - c.start) : `${(c.end - c.start).toFixed(1)} s`}</span>
              <span className="cut-reason">{c.reason}</span>
              {(c.kind === "manual" || c.kind === "pedido") && (
                <button className="danger-btn" disabled={locked} title="Apagar este corte" onClick={() => void act("removeCut", video.id, c.id)}>
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
        {listed.length > shown && <button onClick={() => setShown((n) => n + 400)}>Mostrar mais ({listed.length - shown})</button>}
        {!listed.length && <p className="studio-hint">Nenhum corte neste filtro.</p>}
      </section>
    </div>
  );
}

export function Cuts({ selected, onSelect }: { selected: number | null; onSelect: (id: number) => void }) {
  const videos = useStudio((s) => s.state!.videos).filter(hasCuts);
  const video = videos.find((v) => v.id === selected) ?? videos.find((v) => v.status === "hold") ?? videos[0] ?? null;
  if (!video)
    return (
      <div className="studio-empty">
        <p>Nenhum vídeo passou pelo agente de Corte ainda.</p>
        <p className="studio-hint">Ao adicionar um vídeo no Painel, marque "Parar depois do Corte" para conferir e mudar os cortes antes de os outros agentes seguirem.</p>
      </div>
    );
  return (
    <div className="cuts-tab">
      <div className="cuts-left">
        <div className="shorts-bar">
          <select value={video.id} onChange={(e) => onSelect(Number(e.target.value))}>
            {videos.map((v) => (
              <option key={v.id} value={v.id}>
                {v.status === "hold" ? "● " : ""}
                {v.title}
              </option>
            ))}
          </select>
          {video.data.brief?.text && (
            <span className="studio-hint" title={video.data.brief.text}>
              Seu pedido: {video.data.brief.text.length > 90 ? `${video.data.brief.text.slice(0, 90)}…` : video.data.brief.text}
            </span>
          )}
        </div>
        <Editor key={video.id} video={video} />
      </div>
      <AskCuts video={video} />
    </div>
  );
}

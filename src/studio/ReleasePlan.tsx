import { useMemo, useState } from "react";
import { act, call, useStudio, type StudioVideo } from "./store";

const message = (err: unknown) => String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const day = (offset: number) => {
  const d = new Date(Date.now() + offset * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const seriesName = (v: StudioVideo) => v.data.series?.name ?? (v.data.partOf ? `Partes de #${v.data.partOf.parentId}` : null);

/**
 * When a group of videos comes out: one every few days, at a fixed time or the channel's best hour. The approval stays
 * a click of the creator's per video; with "send on approval" on, each approved video goes up as private and YouTube
 * publishes it on its date.
 */
export function ReleasePlan({ onClose }: { onClose: () => void }) {
  const videos = useStudio((s) => s.state!.videos);
  const publish = useStudio((s) => s.state!.settings.publish);
  const connected = useStudio((s) => s.state!.youtube.connected);
  const open = useMemo(() => videos.filter((v) => v.data.kind !== "short" && !v.data.youtube && v.status !== "divided" && v.status !== "rejected"), [videos]);
  const [picked, setPicked] = useState<number[]>(() => open.filter((v) => !v.data.schedule?.at).map((v) => v.id));
  const [start, setStart] = useState(day(1));
  const [every, setEvery] = useState(2);
  const [time, setTime] = useState("best");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const ordered = open.filter((v) => picked.includes(v.id));
  const ready = ordered.filter((v) => v.status === "review" && !v.data.dirty && v.data.finalPath);

  const move = (id: number, by: number) =>
    setPicked((list) => {
      const i = list.indexOf(id);
      const j = i + by;
      if (i < 0 || j < 0 || j >= list.length) return list;
      const next = [...list];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setNote(null);
    try {
      setNote(await work());
    } catch (err) {
      setNote(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal release-plan">
        <h3>Programar lançamentos</h3>
        <p className="studio-hint">Marque os vídeos na ordem em que devem sair. Cada um ainda precisa da sua aprovação; a data só diz quando o YouTube publica.</p>
        <ul>
          {open.map((v) => {
            const at = picked.indexOf(v.id);
            return (
              <li key={v.id} className={at >= 0 ? "" : "off"}>
                <input type="checkbox" checked={at >= 0} onChange={(e) => setPicked((list) => (e.target.checked ? [...list, v.id] : list.filter((x) => x !== v.id)))} />
                <b>{at >= 0 ? at + 1 : "–"}</b>
                <span className="grow">
                  {v.title}
                  {seriesName(v) ? <small> · {seriesName(v)}</small> : null}
                  <small> · {v.status === "review" ? "pronto" : v.status === "approved" ? "aprovado" : "em produção"}</small>
                  {v.data.schedule?.at ? <small> · {new Date(v.data.schedule.at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</small> : null}
                </span>
                {at >= 0 && (
                  <>
                    <button onClick={() => move(v.id, -1)} title="Sair antes">
                      ▲
                    </button>
                    <button onClick={() => move(v.id, 1)} title="Sair depois">
                      ▼
                    </button>
                  </>
                )}
              </li>
            );
          })}
          {!open.length && <li className="off">Nenhum vídeo para programar.</li>}
        </ul>
        <div className="inline">
          <label className="field">
            <span>Primeiro lançamento</span>
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="field">
            <span>Frequência</span>
            <select value={every} onChange={(e) => setEvery(Number(e.target.value))}>
              <option value={1}>Todo dia</option>
              <option value={2}>Dia sim, dia não</option>
              <option value={3}>A cada 3 dias</option>
              <option value={7}>Uma vez por semana</option>
            </select>
          </label>
          <label className="field">
            <span>Horário</span>
            <select value={/^\d/.test(time) ? "custom" : "best"} onChange={(e) => setTime(e.target.value === "best" ? "best" : "18:00")}>
              <option value="best">Melhor horário do canal</option>
              <option value="custom">Escolher</option>
            </select>
          </label>
          {/^\d/.test(time) && (
            <label className="field">
              <span>Hora</span>
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </label>
          )}
        </div>
        <label className="toggle-row">
          <input type="checkbox" checked={publish.auto} onChange={(e) => void act("setSettings", { publish: { auto: e.target.checked } })} />
          <span>Enviar sozinho para o YouTube assim que eu aprovar (sobe como privado e o YouTube publica na data)</span>
        </label>
        {!connected && <p className="card-error">O canal do YouTube ainda não está conectado (Configurações → YouTube). Dá para programar agora e conectar depois.</p>}
        {note && <p className="studio-hint">{note}</p>}
        <div className="modal-actions">
          <button onClick={onClose} disabled={busy}>
            Fechar
          </button>
          <span className="grow" />
          <button
            disabled={busy || !ready.length}
            title="Aprova os vídeos prontos da lista, um por um, como se você clicasse em Aprovar em cada um"
            onClick={() =>
              confirm(`Aprovar estes ${ready.length} vídeos, como estão agora (arquivo, título, descrição, thumbnail e data)?\n\n${ready.map((v) => `• ${v.title}${v.data.schedule?.at ? ` — ${new Date(v.data.schedule.at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}` : " — sem data"}`).join("\n")}\n\nConfira cada um na revisão antes, se ainda não conferiu.`) &&
              void run(async () => {
                for (const v of ready) await call("approve", v.id);
                return `${ready.length} vídeos aprovados.${publish.auto ? " Eles sobem para o YouTube como privados e saem nas datas marcadas." : " Para enviar, clique em Enviar ao YouTube em cada um, ou ligue o envio automático acima."}`;
              })
            }
          >
            Aprovar os {ready.length} prontos
          </button>
          <button
            className="primary"
            disabled={busy || !ordered.length}
            onClick={() =>
              void run(async () => {
                const planned = await call<{ title: string; at: number }[]>("scheduleSeries", picked.filter((id) => ordered.some((v) => v.id === id)), { start, everyDays: every, time });
                return `Programado: ${planned.map((p) => `${p.title} em ${new Date(p.at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}`).join("; ")}.`;
              })
            }
          >
            Programar {ordered.length} vídeos
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { act, call, clock, useStudio } from "./store";

interface Overview {
  connected: boolean;
  channel?: { title: string; subscribers: number | null; views: number | null; videos: number | null };
  days?: { day: string; views: number; estimatedMinutesWatched: number; subscribersGained: number; subscribersLost: number }[];
  analyticsError?: string | null;
  uploads?: { id: string; url: string; title: string; published: string | null; views: number | null; likes: number | null; comments: number | null; duration: number; privacy: string | null; viewsPerDay: number | null }[];
  times?: { basis: string; detail: string; bestDays: { name: string; score: number }[]; bestHours: number[] };
  quota?: { units: number; searches: number; uploads: number; limits: { units: number; searches: number; uploads: number } };
}

const n = (value: number | null | undefined) => (value == null ? "—" : value.toLocaleString("pt-BR"));

/** One bar per day. The scale starts at zero and the tallest day is labelled, so the height means something. */
function Bars({ rows, pick, label }: { rows: NonNullable<Overview["days"]>; pick: (r: NonNullable<Overview["days"]>[number]) => number; label: string }) {
  const values = rows.map(pick);
  const max = Math.max(1, ...values);
  const total = values.reduce((a, b) => a + b, 0);
  const w = 100 / Math.max(1, rows.length);
  return (
    <figure className="bars">
      <figcaption>
        {label}: <b>{n(Math.round(total))}</b> em {rows.length} dias · maior dia {n(Math.round(max))}
      </figcaption>
      <svg viewBox="0 0 100 32" preserveAspectRatio="none" role="img" aria-label={`${label} por dia`}>
        {values.map((v, i) => (
          <rect key={rows[i].day} x={i * w + w * 0.12} width={w * 0.76} y={32 - (v / max) * 30} height={Math.max(0.3, (v / max) * 30)}>
            <title>{`${rows[i].day.split("-").reverse().join("/")}: ${n(Math.round(v))}`}</title>
          </rect>
        ))}
      </svg>
      <small>
        <span>{rows[0]?.day.split("-").reverse().slice(0, 2).join("/")}</span>
        <span>{rows[rows.length - 1]?.day.split("-").reverse().slice(0, 2).join("/")}</span>
      </small>
    </figure>
  );
}

export function Channel() {
  const youtube = useStudio((s) => s.state!.youtube);
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!youtube.connected) return;
    setError(null);
    call<Overview>("channel").then(setData, (err: Error) => setError(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")));
  }, [youtube.connected]);

  if (!youtube.connected) return <p className="studio-empty big">Conecte o canal do YouTube nas Configurações para ver os números dele aqui.</p>;
  if (error) return <p className="studio-empty big">Não consegui ler o canal: {error}</p>;
  if (!data) return <p className="studio-empty big">Lendo o canal…</p>;
  const days = data.days ?? [];
  const net = days.reduce((sum, d) => sum + d.subscribersGained - d.subscribersLost, 0);

  return (
    <div className="channel">
      <section className="channel-top">
        <h3>{data.channel?.title}</h3>
        <div className="stat">
          <b>{n(data.channel?.subscribers)}</b>
          <span>inscritos</span>
        </div>
        <div className="stat">
          <b>{n(data.channel?.views)}</b>
          <span>visualizações no total</span>
        </div>
        <div className="stat">
          <b>{n(data.channel?.videos)}</b>
          <span>vídeos</span>
        </div>
        <div className="stat">
          <b>{net > 0 ? `+${n(net)}` : n(net)}</b>
          <span>inscritos em {days.length} dias</span>
        </div>
      </section>

      {data.analyticsError ? (
        <p className="studio-alert">Os números diários não vieram: {data.analyticsError}</p>
      ) : days.length ? (
        <section className="channel-charts">
          <Bars rows={days} pick={(d) => d.views} label="Visualizações" />
          <Bars rows={days} pick={(d) => d.estimatedMinutesWatched / 60} label="Horas assistidas" />
        </section>
      ) : (
        <p className="studio-hint">O canal ainda não tem números diários.</p>
      )}

      <section>
        <h3>Melhor horário para publicar</h3>
        <p>
          Dias: <b>{data.times?.bestDays.slice(0, 3).map((d) => d.name).join(", ")}</b> · Horas: <b>{data.times?.bestHours.map((h) => `${h}h`).join(", ")}</b>
        </p>
        <p className="studio-hint">
          {data.times?.detail} O YouTube não informa pela API em que hora o público está online; por isso o cálculo usa o desempenho dos vídeos pela hora em que saíram.
        </p>
      </section>

      <section>
        <h3>Últimos vídeos do canal</h3>
        <table className="uploads">
          <thead>
            <tr>
              <th>Vídeo</th>
              <th>Publicado</th>
              <th>Duração</th>
              <th>Views</th>
              <th>Views/dia</th>
              <th>Curtidas</th>
              <th>Comentários</th>
            </tr>
          </thead>
          <tbody>
            {(data.uploads ?? []).map((v) => (
              <tr key={v.id}>
                <td>
                  <a href="#" onClick={(e) => (e.preventDefault(), void act("openLink", v.url))}>
                    {v.title}
                  </a>
                  {v.privacy && v.privacy !== "public" ? <small> · {v.privacy === "private" ? "privado" : "não listado"}</small> : null}
                </td>
                <td>{v.published ? new Date(v.published).toLocaleDateString("pt-BR") : "—"}</td>
                <td>{clock(v.duration)}</td>
                <td>{n(v.views)}</td>
                <td>{n(v.viewsPerDay)}</td>
                <td>{n(v.likes)}</td>
                <td>{n(v.comments)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!(data.uploads ?? []).length && <p className="studio-empty">O canal ainda não tem vídeos.</p>}
      </section>

      {data.quota && (
        <p className="studio-hint">
          Cota da API do YouTube usada hoje: {n(data.quota.units)} de {n(data.quota.limits.units)} unidades · {data.quota.searches} de {data.quota.limits.searches} buscas · {data.quota.uploads} de {data.quota.limits.uploads} envios. Volta à meia-noite da Califórnia. Os números desta tela são lidos no máximo uma vez por hora.
        </p>
      )}
    </div>
  );
}

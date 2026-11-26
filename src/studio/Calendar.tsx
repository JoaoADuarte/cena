import { useState } from "react";
import { reschedule, when } from "./Publish";
import { useStudio, type StudioVideo } from "./store";

const WEEK = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** When a video goes (or went) public, and how sure that is. */
function slot(v: StudioVideo): { at: number; kind: "sent" | "scheduled" | "planned" } | null {
  const yt = v.data.youtube;
  if (yt) return { at: yt.publishAt ?? yt.uploadedAt, kind: yt.publishAt && yt.publishAt > Date.now() ? "scheduled" : "sent" };
  if (v.data.schedule?.at && v.status !== "rejected") return { at: v.data.schedule.at, kind: "planned" };
  return null;
}

/** The month at a glance. Drag a video to another day to change its date; the hour is kept. */
export function Calendar({ onReview }: { onReview: (id: number) => void }) {
  const videos = useStudio((s) => s.state!.videos);
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [over, setOver] = useState<string | null>(null);

  const first = new Date(month);
  first.setDate(1 - first.getDay());
  const days = Array.from({ length: 42 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + i));
  const placed = videos.map((v) => ({ v, s: slot(v) })).filter((x): x is { v: StudioVideo; s: NonNullable<ReturnType<typeof slot>> } => x.s !== null);
  const loose = videos.filter((v) => !slot(v) && v.data.finalPath && v.status !== "rejected");
  const today = dayKey(new Date());

  const drop = (day: Date, id: number) => {
    const video = videos.find((v) => v.id === id);
    if (!video) return;
    const from = video.data.schedule?.at ? new Date(video.data.schedule.at) : null;
    const at = new Date(day);
    at.setHours(from?.getHours() ?? 18, from?.getMinutes() ?? 0, 0, 0);
    if (at.getTime() < Date.now() + 20 * 60_000) {
      useStudio.setState({ error: "Escolha um dia e horário no futuro." });
      return;
    }
    void reschedule(video, at.getTime());
  };

  const chip = (v: StudioVideo, kind: string, label: string) => (
    <div
      key={v.id}
      className={`cal-chip cal-${kind} cal-status-${v.status}`}
      draggable={!v.data.youtube}
      onDragStart={(e) => e.dataTransfer.setData("text/cena-video", String(v.id))}
      onClick={() => onReview(v.id)}
      title={`${v.title}${v.data.metadata?.title ? `\n${v.data.metadata.title}` : ""}\n${kind === "sent" ? "Publicado" : kind === "scheduled" ? "Enviado, o YouTube publica nesta hora" : kind === "planned" ? (v.status === "approved" ? "Aprovado, aguardando o envio" : "Data planejada, ainda sem aprovação") : "Sem data"}`}
    >
      <b>{label}</b> {v.data.metadata?.title || v.title}
    </div>
  );

  return (
    <div className="calendar">
      <header>
        <button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>‹</button>
        <h3>{month.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })}</h3>
        <button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>›</button>
        <span className="studio-hint">Arraste um vídeo para outro dia para mudar a data. Vídeo já enviado só muda no YouTube Studio.</span>
        <div className="grow" />
        <span className="cal-legend">
          <i className="cal-planned" /> planejado <i className="cal-planned cal-status-approved" /> aprovado <i className="cal-scheduled" /> agendado no YouTube <i className="cal-sent" /> publicado
        </span>
      </header>
      <div className="cal-body">
        <div className="cal-grid">
          {WEEK.map((w) => (
            <div key={w} className="cal-week">
              {w}
            </div>
          ))}
          {days.map((d) => {
            const key = dayKey(d);
            return (
              <div
                key={key}
                className={`cal-day${d.getMonth() !== month.getMonth() ? " other" : ""}${key === today ? " today" : ""}${over === key ? " over" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOver(key);
                }}
                onDragLeave={() => setOver((o) => (o === key ? null : o))}
                onDrop={(e) => {
                  e.preventDefault();
                  setOver(null);
                  const id = Number(e.dataTransfer.getData("text/cena-video"));
                  if (id) drop(d, id);
                }}
              >
                <span>{d.getDate()}</span>
                {placed
                  .filter((x) => dayKey(new Date(x.s.at)) === key)
                  .sort((a, b) => a.s.at - b.s.at)
                  .map((x) => chip(x.v, x.s.kind, new Date(x.s.at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })))}
              </div>
            );
          })}
        </div>
        <aside>
          <h3>Sem data ({loose.length})</h3>
          {loose.map((v) => chip(v, "loose", v.status === "approved" ? "✓" : "·"))}
          {!loose.length && <p className="studio-empty">Todos os vídeos prontos têm data.</p>}
          <h3>Próximos</h3>
          {placed
            .filter((x) => x.s.at > Date.now())
            .sort((a, b) => a.s.at - b.s.at)
            .slice(0, 8)
            .map((x) => (
              <p key={x.v.id} className="studio-hint">
                {when(x.s.at)} · {x.v.data.metadata?.title || x.v.title}
              </p>
            ))}
        </aside>
      </div>
    </div>
  );
}

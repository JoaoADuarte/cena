import { useEffect, useState } from "react";
import { Icon } from "../components/controls";
import { Calendar } from "./Calendar";
import { Channel } from "./Channel";
import { Cuts, hasCuts } from "./Cuts";
import { Dashboard } from "./Dashboard";
import { Review } from "./Review";
import { Scripts } from "./Scripts";
import { Settings } from "./Settings";
import { Shorts } from "./Shorts";
import { Trends } from "./Trends";
import { Growth } from "./Growth";
import { act, startStudio, useStudio } from "./store";

type Tab = "dashboard" | "growth" | "trends" | "cuts" | "scripts" | "review" | "shorts" | "calendar" | "channel" | "settings";
const TABS: Tab[] = ["dashboard", "growth", "trends", "cuts", "scripts", "review", "shorts", "calendar", "channel", "settings"];

/** The studio panel: what the agents are doing, and the two places where the creator decides. */
export function StudioApp() {
  const state = useStudio((s) => s.state);
  const error = useStudio((s) => s.error);
  const [tab, setTab] = useState<Tab>("dashboard");
  const [reviewing, setReviewing] = useState<number | null>(null);
  const [cutting, setCutting] = useState<number | null>(null);
  const [trendTopic, setTrendTopic] = useState("");

  useEffect(() => startStudio(), []);
  // The editor opens the studio on a tab (its assistant's "Tendências" button).
  useEffect(() => window.api.onStudioTab((t) => TABS.includes(t as Tab) && setTab(t as Tab)), []);

  if (!state) return <div className="studio-loading">Abrindo o Estúdio…</div>;

  const waitingVideos = state.videos.filter((v) => v.status === "review" && v.data.kind !== "short").length;
  const waitingShorts = state.videos.filter((v) => v.status === "review" && v.data.kind === "short").length;
  const open = (id: number) => {
    if (state.videos.find((v) => v.id === id)?.data.kind === "short") return setTab("shorts");
    setReviewing(id);
    setTab("review");
  };
  const waitingCuts = state.videos.filter((v) => v.status === "hold" && hasCuts(v)).length;
  const openCuts = (id: number) => {
    setCutting(id);
    setTab("cuts");
  };
  const waitingScripts = state.scripts.filter((s) => s.status === "review").length;
  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: "dashboard", label: "Painel" },
    { id: "growth", label: "Crescer" },
    { id: "trends", label: "Tendências" },
    { id: "cuts", label: "Cortes", badge: waitingCuts },
    { id: "scripts", label: "Roteiros", badge: waitingScripts },
    { id: "review", label: "Aguardando aprovação", badge: waitingVideos },
    { id: "shorts", label: "Shorts", badge: waitingShorts },
    { id: "calendar", label: "Calendário" },
    { id: "channel", label: "Canal" },
    { id: "settings", label: "Configurações" },
  ];

  return (
    <div className="studio">
      <header className="studio-top">
        <span className="studio-brand">
          <Icon name="film" /> Cena Estúdio
        </span>
        <nav>
          {tabs.map((t) => (
            <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
              {t.label}
              {t.badge ? <b className="badge">{t.badge}</b> : null}
            </button>
          ))}
        </nav>
        <div className="grow" />
        <button className={state.settings.paused ? "toggle-on" : ""} onClick={() => void act("setSettings", { paused: !state.settings.paused })} title="Pausa a fila inteira: o que está rodando termina, nada novo começa">
          <Icon name={state.settings.paused ? "play" : "pause"} /> {state.settings.paused ? "Retomar a fila" : "Pausar a fila"}
        </button>
      </header>
      {!state.claude && (
        <div className="studio-alert">O Claude Code não foi encontrado neste computador. Sem ele os agentes de Pesquisa, Roteiro e a avaliação de takes não funcionam; silêncios, áudio e montagem continuam funcionando.</div>
      )}
      {error && (
        <div className="studio-alert error" onClick={() => useStudio.setState({ error: null })}>
          {error}
        </div>
      )}
      <main className="studio-main">
        {tab === "dashboard" && (
          <Dashboard onReview={open} onCuts={openCuts} />
        )}
        {tab === "growth" && <Growth onScripts={() => setTab("scripts")} onShorts={() => setTab("shorts")} onResearch={(t) => (setTrendTopic(t), setTab("trends"))} />}
        {tab === "trends" && <Trends onSettings={() => setTab("settings")} onScripts={() => setTab("scripts")} initialTopic={trendTopic} />}
        {tab === "cuts" && <Cuts selected={cutting} onSelect={setCutting} />}
        {tab === "scripts" && <Scripts />}
        {tab === "review" && <Review selected={reviewing} onSelect={setReviewing} />}
        {tab === "calendar" && (
          <Calendar onReview={open} />
        )}
        {tab === "shorts" && <Shorts />}
        {tab === "channel" && <Channel />}
        {tab === "settings" && <Settings />}
      </main>
    </div>
  );
}

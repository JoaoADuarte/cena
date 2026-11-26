import { useEffect, useState } from "react";
import { Icon } from "../components/controls";
import { act, call, useStudio } from "./store";
import { StudyProgress } from "./Trends";

interface GrowthTips {
  at: number;
  connected: boolean;
  diagnosis: string;
  working: string[];
  tips: { title: string; why: string; how: string }[];
  ideas: { title: string; format: "long" | "short"; why: string; hook: string; game: string }[];
  shorts: { videoId: number; why: string }[];
  research: string[];
  rhythm: string;
  confidence: string;
  limits: string;
}

/**
 * Crescer: the Growth agent reads the channel's numbers, the recordings in the studio and the trends researched,
 * and says which videos and Shorts to make next. It only suggests; every action is a click of the creator.
 */
export function Growth({ onScripts, onShorts, onResearch }: { onScripts: () => void; onShorts: () => void; onResearch: (topic: string) => void }) {
  const tick = useStudio((s) => s.tick);
  const videos = useStudio((s) => s.state!.videos);
  const youtube = useStudio((s) => s.state!.youtube);
  const claude = useStudio((s) => s.state!.claude);
  const [tips, setTips] = useState<GrowthTips | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [made, setMade] = useState<string[]>([]);

  useEffect(() => void call<GrowthTips | null>("growth").then(setTips), [tick]);

  const run = async () => {
    setBusy(Date.now());
    const out = (await act("growthTips")) as GrowthTips | undefined;
    setBusy(null);
    if (out) setTips(out);
  };
  const title = (id: number) => videos.find((v) => v.id === id)?.title ?? `Vídeo ${id}`;

  return (
    <div className="growth">
      <header className="growth-head">
        <div>
          <h2>Dicas para crescer o canal</h2>
          <p className="trends-hint">
            O agente compara os seus vídeos entre si{youtube.connected ? "" : " (conecte o canal em Configurações para ele ver os seus números)"}, olha as gravações que estão no Estúdio e o que você pesquisou em Tendências. Depois diz o que gravar e quais
            Shorts fazer. Nada é feito sem você clicar.
          </p>
        </div>
        {busy ? (
          <div className="growth-busy">
            <StudyProgress since={busy} onStop={() => void act("cancelGrowth")} />
          </div>
        ) : (
          <button className="primary" disabled={!claude} onClick={() => void run()}>
            <Icon name="sparkle" /> {tips ? "Analisar de novo" : "Analisar e sugerir"}
          </button>
        )}
      </header>

      {!tips && !busy && (
        <div className="trends-empty">
          <Icon name="sparkle" />
          <p>Clique em Analisar e sugerir. Leva de 1 a 2 minutos e gasta uns 20 mil tokens do seu plano do Claude.</p>
        </div>
      )}

      {tips && (
        <>
          <p className="growth-date">
            Análise de {new Date(tips.at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}
            {tips.connected ? " com os números do canal" : " sem os números do canal"} · confiança {tips.confidence || "?"}
          </p>
          <p className="style-summary">{tips.diagnosis}</p>
          {tips.working.length > 0 && (
            <section className="growth-box">
              <h4>O que já funciona no seu canal</h4>
              <ul>
                {tips.working.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </section>
          )}

          <h3>Dicas</h3>
          <ol className="growth-tips">
            {tips.tips.map((t, i) => (
              <li key={i}>
                <b>{t.title}</b>
                {t.why && <p>{t.why}</p>}
                {t.how && <p className="growth-how">Como: {t.how}</p>}
              </li>
            ))}
          </ol>
          {tips.rhythm && (
            <p>
              <b>Ritmo de postagem:</b> {tips.rhythm}
            </p>
          )}

          {tips.shorts.length > 0 && (
            <>
              <h3>Faça Shorts destas gravações</h3>
              <ul className="growth-shorts">
                {tips.shorts.map((s) => (
                  <li key={s.videoId}>
                    <div>
                      <b>{title(s.videoId)}</b>
                      <p>{s.why}</p>
                    </div>
                    {made.includes(`v${s.videoId}`) ? (
                      <button onClick={onShorts}>Gerando · ver em Shorts</button>
                    ) : (
                      <button onClick={() => void act("autoShorts", s.videoId).then((r) => r && setMade([...made, `v${s.videoId}`]))} title="O agente de Shorts gera os melhores momentos desta gravação e um Story. Cada um espera a sua aprovação.">
                        Gerar Shorts
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}

          <h3>Vídeos para gravar</h3>
          <ul className="style-ideas">
            {tips.ideas.map((idea, i) => (
              <li key={i}>
                <div>
                  <b>{idea.title}</b>
                  <em>{idea.format === "short" ? "Short" : "Vídeo longo"}</em>
                </div>
                {idea.game && <small className="style-small">{idea.game}</small>}
                <p>{idea.why}</p>
                {idea.hook && <p className="style-hook">“{idea.hook}”</p>}
                {made.includes(`i${i}`) ? (
                  <button onClick={onScripts}>Roteiro pedido · ver em Roteiros</button>
                ) : (
                  <button onClick={() => void act("scriptFromGrowth", i).then((id) => id && setMade([...made, `i${i}`]))}>
                    <Icon name="text" /> Criar roteiro
                  </button>
                )}
              </li>
            ))}
          </ul>

          {tips.research.length > 0 && (
            <>
              <h3>Pesquise em Tendências</h3>
              <div className="chips">
                {tips.research.map((r) => (
                  <button key={r} onClick={() => onResearch(r)}>
                    <Icon name="search" /> {r}
                  </button>
                ))}
              </div>
            </>
          )}
          {tips.limits && <p className="style-small growth-limits">Limites: {tips.limits}</p>}
        </>
      )}
    </div>
  );
}

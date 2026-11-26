import { useEffect, useMemo, useState } from "react";
import { Icon } from "../components/controls";
import { act, call, clock, useStudio, type LogLine } from "./store";

export interface TrendVideo {
  id: string;
  url: string;
  title: string;
  channel: string;
  published: string;
  thumb: string | null;
  duration: number;
  views: number;
  likes: number | null;
  comments: number | null;
  subscribers: number | null;
  days: number;
  viewsPerDay: number | null;
  viewsPerSubscriber: number | null;
  engagement: number | null;
  tags: string[];
}

export interface TrendSearch {
  at: number;
  topic: string;
  days: number | null;
  format: "all" | "short" | "long";
  videos: TrendVideo[];
  insights: {
    terms: { term: string; videos: number }[];
    duration: { median: number | null; short: number; long: number };
    titles: { length: number | null; question: number; number: number; caps: number; emoji: number };
    outliers: number;
    timing: { days: number[]; hours: number[] };
  };
}

export interface StyleIdea {
  title: string;
  format: "long" | "short";
  why: string;
  hook: string;
  basedOn: string[];
}

export interface StudiedStyle {
  id: string;
  created: number;
  topic: string;
  name: string;
  summary: string;
  script: { hook: string; structure: string[]; retention: string[]; cta: string; tone: string };
  editing: { measured: boolean; pace: string; cutEverySeconds: number | null; captions: string; zooms: string; music: string; sounds: string; overlays: string; transitions: string; rules: string[] };
  titles: { formulas: string[]; examples: string[] };
  thumbnails: string;
  duration: string;
  posting: string;
  trends: string[];
  ideas: StyleIdea[];
  confidence: string;
  limits: string;
  references: { id: string; title: string; channel: string; url: string; views: number; thumb: string | null }[];
  measured: { file: string; duration: number; cutsPerMinute?: number | null; averageShotSeconds?: number | null; wordsPerMinute?: number; actionShare?: number | null; vertical?: boolean; hook?: string }[];
}

interface TrendsData {
  searches: TrendSearch[];
  styles: StudiedStyle[];
  active: string | null;
}

const PERIODS = [
  { days: 7, label: "Última semana" },
  { days: 30, label: "Último mês" },
  { days: 90, label: "Últimos 3 meses" },
  { days: 365, label: "Último ano" },
  { days: 0, label: "Desde sempre" },
];
const FORMATS = [
  { id: "all", label: "Todos" },
  { id: "short", label: "Cortes e Shorts (até 4 min)" },
  { id: "long", label: "Vídeos longos" },
] as const;
const WEEK = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

const big = (n: number | null | undefined) => (n == null ? "?" : n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(".0", "")} mi` : n >= 1e3 ? `${Math.round(n / 1e3)} mil` : String(Math.round(n)));
const ago = (days: number) => (days < 1 ? "hoje" : days < 30 ? `há ${days} d` : days < 365 ? `há ${Math.round(days / 30)} meses` : `há ${(days / 365).toFixed(1).replace(".0", "")} anos`);

/**
 * Tendências: the most watched videos on a subject, what they have in common, and the style the AI studies from the
 * ones the creator picks. A style can be followed by the editor's assistant and the agents, and its ideas become scripts.
 */
export function Trends({ onSettings, onScripts, initialTopic = "" }: { onSettings: () => void; onScripts: () => void; initialTopic?: string }) {
  const youtube = useStudio((s) => s.state?.youtube);
  const tick = useStudio((s) => s.tick);
  const [data, setData] = useState<TrendsData>({ searches: [], styles: [], active: null });
  const [topic, setTopic] = useState(initialTopic);
  useEffect(() => {
    if (initialTopic) setTopic(initialTopic);
  }, [initialTopic]);
  const [days, setDays] = useState(30);
  const [format, setFormat] = useState<TrendSearch["format"]>("all");
  const [searching, setSearching] = useState(false);
  const [shown, setShown] = useState<number | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [studying, setStudying] = useState<number | null>(null);
  const [openStyle, setOpenStyle] = useState<string | null>(null);
  const [sort, setSort] = useState<"views" | "perDay" | "perSub">("views");

  const load = () => void call<TrendsData>("trends").then(setData);
  useEffect(load, [tick]);
  useEffect(() => {
    void call<boolean>("studying").then((on) => on && setStudying(Date.now()));
  }, []);

  const search = data.searches.find((s) => s.at === shown) ?? data.searches[0] ?? null;
  const canRead = Boolean(youtube?.apiKey || youtube?.connected);
  const style = data.styles.find((s) => s.id === openStyle) ?? null;

  const run = async () => {
    if (!topic.trim()) return;
    setSearching(true);
    const found = (await act("searchTrends", { topic, days: days || null, format })) as TrendSearch | undefined;
    setSearching(false);
    if (found) {
      setShown(found.at);
      setPicked(found.videos.slice(0, 5).map((v) => v.id));
      setOpenStyle(null);
      load();
    }
  };

  const study = async () => {
    setStudying(Date.now());
    const made = (await act("studyStyle", { at: search?.at ?? null, ids: picked, files })) as StudiedStyle | undefined;
    setStudying(null);
    if (made) {
      setFiles([]);
      setOpenStyle(made.id);
      load();
    }
  };

  const videos = useMemo(() => {
    const list = [...(search?.videos ?? [])];
    const key = (v: TrendVideo) => (sort === "views" ? v.views : sort === "perDay" ? v.viewsPerDay ?? 0 : v.viewsPerSubscriber ?? 0);
    return list.sort((a, b) => key(b) - key(a));
  }, [search, sort]);

  const toggle = (id: string) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= 10 ? cur : [...cur, id]));

  return (
    <div className="trends">
      <section className="trends-main">
        <form
          className="trends-search"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Assunto: ex. GTA RP polícia, Minecraft hardcore, Forza Horizon 5 corrida" disabled={!canRead} />
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {PERIODS.map((p) => (
              <option key={p.days} value={p.days}>
                {p.label}
              </option>
            ))}
          </select>
          <select value={format} onChange={(e) => setFormat(e.target.value as TrendSearch["format"])}>
            {FORMATS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
          <button className="primary" disabled={!canRead || searching || !topic.trim()}>
            <Icon name="search" /> {searching ? "Pesquisando…" : "Pesquisar"}
          </button>
        </form>
        {!canRead && (
          <div className="studio-alert">
            A pesquisa usa a YouTube Data API, com números exatos. Coloque a sua chave da API (ou conecte o canal) em Configurações → YouTube.{" "}
            <button onClick={onSettings}>Abrir Configurações</button>
          </div>
        )}
        {canRead && youtube?.quota && (
          <p className="trends-quota">
            Cada pesquisa usa 2 das {youtube.quota.limits.searches} buscas que a API permite por dia (hoje: {youtube.quota.searches ?? 0} usadas). A mesma pesquisa no mesmo dia vem da memória e não gasta.
          </p>
        )}
        {data.searches.length > 0 && (
          <div className="chips trends-history">
            {data.searches.map((s) => (
              <button key={s.at} className={search?.at === s.at ? "toggle-on" : ""} onClick={() => (setShown(s.at), setOpenStyle(null), setPicked(s.videos.slice(0, 5).map((v) => v.id)))}>
                {s.topic} · {PERIODS.find((p) => p.days === (s.days ?? 0))?.label.toLowerCase() ?? ""}
              </button>
            ))}
          </div>
        )}

        {style ? (
          <StyleView style={style} active={data.active === style.id} onClose={() => setOpenStyle(null)} onChanged={load} onScripts={onScripts} />
        ) : search ? (
          <>
            <Insights search={search} />
            <div className="trends-list-head">
              <h3>
                {search.videos.length} vídeos sobre “{search.topic}”
              </h3>
              <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
                <option value="views">Mais vistos</option>
                <option value="perDay">Mais vistos por dia (crescendo agora)</option>
                <option value="perSub">Acima do tamanho do canal</option>
              </select>
            </div>
            <ul className="trends-videos">
              {videos.map((v, i) => (
                <li key={v.id} className={picked.includes(v.id) ? "picked" : ""}>
                  <label className="trends-pick" title="Estudar o estilo deste vídeo">
                    <input type="checkbox" checked={picked.includes(v.id)} onChange={() => toggle(v.id)} />
                  </label>
                  <span className="trends-rank">{i + 1}</span>
                  <a href="#" className="trends-thumb" onClick={(e) => (e.preventDefault(), void window.api.openExternal(v.url))} title="Abrir no YouTube">
                    {v.thumb ? <img src={v.thumb} alt="" loading="lazy" /> : <span />}
                    <i>{clock(v.duration)}</i>
                  </a>
                  <div className="trends-info">
                    <b title={v.title}>{v.title}</b>
                    <span>
                      {v.channel} · {big(v.subscribers)} inscritos · {ago(v.days)}
                    </span>
                    <span className="trends-numbers">
                      <em>{big(v.views)} visualizações</em> · {big(v.viewsPerDay)}/dia
                      {v.viewsPerSubscriber != null && v.viewsPerSubscriber >= 3 && <strong title="Muito mais visualizações do que inscritos: o vídeo foi além do público do canal">{Math.round(v.viewsPerSubscriber)}× o canal</strong>}
                      {v.engagement != null && ` · ${(v.engagement * 100).toFixed(1)}% curtidas+comentários`}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div className="trends-empty">
            <Icon name="search" />
            <p>Pesquise um assunto para ver os vídeos mais vistos, o que eles têm em comum e o que está crescendo agora.</p>
            <p>Depois marque os que você quer imitar: a IA estuda o roteiro, o estilo de edição, os títulos e as capas, e sugere vídeos para você gravar.</p>
          </div>
        )}
      </section>

      <aside className="trends-side">
        <h3>Estudar o estilo</h3>
        <p className="trends-hint">
          Marque até 10 vídeos da lista ({picked.length} marcados). A IA lê os números, títulos, descrições e capas deles. Ela não assiste vídeos do YouTube; para copiar o ritmo de edição de verdade, adicione
          vídeos de referência do seu computador e o Cena mede os cortes, a fala e o visual.
        </p>
        <div className="trends-files">
          {files.map((f) => (
            <span key={f}>
              <Icon name="film" /> {f.split(/[\\/]/).pop()}
              <button title="Tirar" onClick={() => setFiles(files.filter((x) => x !== f))}>
                ×
              </button>
            </span>
          ))}
          <button onClick={() => void call<string[]>("pickReferenceVideos").then((list) => setFiles([...new Set([...files, ...list])].slice(0, 4)))} disabled={Boolean(studying)}>
            <Icon name="plus" /> Vídeo de referência do PC
          </button>
        </div>
        {studying ? (
          <StudyProgress since={studying} />
        ) : (
          <button className="primary trends-study" disabled={!picked.length && !files.length} onClick={() => void study()}>
            <Icon name="sparkle" /> Estudar estilo e sugerir vídeos
          </button>
        )}

        <h3>Estilos estudados</h3>
        {data.styles.length === 0 && <p className="trends-hint">Nenhum ainda.</p>}
        <ul className="trends-styles">
          {data.styles.map((s) => (
            <li key={s.id} className={openStyle === s.id ? "open" : ""} onClick={() => setOpenStyle(s.id)}>
              <b>
                {s.name}
                {data.active === s.id && <em className="trends-active">em uso</em>}
              </b>
              <span>
                {s.topic} · {new Date(s.created).toLocaleDateString("pt-BR")} · {s.ideas.length} ideias
              </span>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

export function StudyProgress({ since, onStop = () => void act("cancelStudy") }: { since: number; onStop?: () => void }) {
  const tick = useStudio((s) => s.tick);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    void call<LogLine[]>("logs", { limit: 60 }).then((l) => setLines(l.filter((x) => x.agent === "research" && x.time >= since - 1000).slice(0, 4).reverse()));
  }, [tick, since]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="trends-progress">
      <div>
        <b>Trabalhando… {clock((now - since) / 1000)}</b>
        <button onClick={onStop}>Parar</button>
      </div>
      {lines.map((l) => (
        <p key={l.id}>{l.message}</p>
      ))}
    </div>
  );
}

function Insights({ search }: { search: TrendSearch }) {
  const i = search.insights;
  const bestDay = i.timing.days.indexOf(Math.max(...i.timing.days));
  const hours = i.timing.hours
    .map((n, h) => ({ n, h }))
    .sort((a, b) => b.n - a.n)
    .filter((x) => x.n > 0)
    .slice(0, 3)
    .map((x) => `${x.h}h`);
  return (
    <div className="trends-insights">
      <div>
        <span>Termos em alta nos títulos</span>
        <div className="chips">
          {i.terms.length ? i.terms.map((t) => <b key={t.term} title={`Em ${t.videos} vídeos`}>{t.term}</b>) : <em>nenhum se repete</em>}
        </div>
      </div>
      <div>
        <span>Duração dos 10 mais vistos</span>
        <strong>{i.duration.median ? clock(i.duration.median) : "?"}</strong>
        <small>
          {i.duration.short}% até 4 min · {i.duration.long}% com 20 min ou mais
        </small>
      </div>
      <div>
        <span>Títulos</span>
        <strong>{i.titles.length ?? "?"} letras</strong>
        <small>
          {i.titles.number}% com número · {i.titles.question}% pergunta · {i.titles.caps}% MAIÚSCULAS · {i.titles.emoji}% emoji
        </small>
      </div>
      <div>
        <span>Quando saíram (Brasília)</span>
        <strong>{Math.max(...i.timing.days) ? WEEK[bestDay] : "?"}</strong>
        <small>{hours.length ? `mais às ${hours.join(", ")}` : ""}</small>
      </div>
      <div>
        <span>Foram além do canal</span>
        <strong>{i.outliers}</strong>
        <small>vídeos com 3× mais visualizações que inscritos</small>
      </div>
    </div>
  );
}

function StyleView({ style, active, onClose, onChanged, onScripts }: { style: StudiedStyle; active: boolean; onClose: () => void; onChanged: () => void; onScripts: () => void }) {
  const [made, setMade] = useState<number[]>([]);
  const e = style.editing;
  const editing: [string, string][] = (
    [
      ["Ritmo", e.pace + (e.cutEverySeconds ? ` (um corte a cada ~${e.cutEverySeconds} s)` : "")],
      ["Legendas", e.captions],
      ["Zooms", e.zooms],
      ["Música", e.music],
      ["Sons e memes", e.sounds],
      ["Textos e elementos", e.overlays],
      ["Transições", e.transitions],
    ] as [string, string][]
  ).filter(([, v]) => v.trim());
  return (
    <div className="style-view">
      <div className="style-head">
        <button onClick={onClose} title="Voltar à pesquisa">
          <Icon name="close" />
        </button>
        <div>
          <h2>{style.name}</h2>
          <span>
            Estudado de {style.references.length} vídeo(s) sobre “{style.topic}”{style.measured.length ? ` e ${style.measured.length} vídeo(s) de referência medidos` : ""} · confiança {style.confidence || "?"}
          </span>
        </div>
        <div className="grow" />
        <button className="primary" onClick={() => void act("applyStyleInEditor", style.id).then(onChanged)} title="Abre o editor com o pedido pronto para a IA editar o projeto aberto neste estilo">
          <Icon name="sparkle" /> Aplicar no editor
        </button>
        <button className={active ? "toggle-on" : ""} onClick={() => void act("setActiveStyle", active ? null : style.id).then(onChanged)} title="O estilo em uso é seguido pela IA do editor e pelos agentes de Edição e Roteiro">
          {active ? "Em uso" : "Usar como padrão"}
        </button>
        <button onClick={() => confirm(`Apagar o estilo "${style.name}"?`) && void act("deleteStyle", style.id).then(() => (onChanged(), onClose()))} title="Apagar">
          <Icon name="trash" />
        </button>
      </div>
      <p className="style-summary">{style.summary}</p>

      <div className="style-grid">
        <section>
          <h4>Roteiro</h4>
          {style.script.hook && (
            <p>
              <b>Começo:</b> {style.script.hook}
            </p>
          )}
          {style.script.structure.length > 0 && (
            <ol>
              {style.script.structure.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          )}
          {style.script.retention.length > 0 && (
            <>
              <b>O que segura o público</b>
              <ul>
                {style.script.retention.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </>
          )}
          {style.script.cta && (
            <p>
              <b>Chamada:</b> {style.script.cta}
            </p>
          )}
          {style.script.tone && (
            <p>
              <b>Tom:</b> {style.script.tone}
            </p>
          )}
        </section>
        <section>
          <h4>
            Edição <em className={e.measured ? "style-measured" : "style-inferred"}>{e.measured ? "medida nos vídeos de referência" : "deduzida, sem vídeo de referência"}</em>
          </h4>
          {editing.map(([k, v]) => (
            <p key={k}>
              <b>{k}:</b> {v}
            </p>
          ))}
          {e.rules.length > 0 && (
            <>
              <b>Regras para o editor</b>
              <ul>
                {e.rules.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </>
          )}
          {style.measured.length > 0 && (
            <p className="style-small">
              {style.measured.map((m) => `${m.file}: ${m.cutsPerMinute ?? "?"} cortes/min, plano de ${m.averageShotSeconds ?? "?"} s${m.wordsPerMinute ? `, ${m.wordsPerMinute} palavras/min` : ""}`).join(" · ")}
            </p>
          )}
        </section>
        <section>
          <h4>Títulos e capas</h4>
          {style.titles.formulas.length > 0 && (
            <>
              <b>Fórmulas</b>
              <ul>
                {style.titles.formulas.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </>
          )}
          {style.titles.examples.length > 0 && (
            <>
              <b>Títulos para você</b>
              <ul>
                {style.titles.examples.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </>
          )}
          {style.thumbnails && (
            <p>
              <b>Capas:</b> {style.thumbnails}
            </p>
          )}
          {style.duration && (
            <p>
              <b>Duração:</b> {style.duration}
            </p>
          )}
          {style.posting && (
            <p>
              <b>Quando postar:</b> {style.posting}
            </p>
          )}
        </section>
        <section>
          <h4>Tendências</h4>
          <ul>
            {style.trends.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
          {style.limits && <p className="style-small">Limites: {style.limits}</p>}
        </section>
      </div>

      <h3>Ideias de vídeos para gravar</h3>
      <ul className="style-ideas">
        {style.ideas.map((idea, i) => (
          <li key={i}>
            <div>
              <b>{idea.title}</b>
              <em>{idea.format === "short" ? "Short" : "Vídeo longo"}</em>
            </div>
            <p>{idea.why}</p>
            {idea.hook && <p className="style-hook">“{idea.hook}”</p>}
            {made.includes(i) ? (
              <button onClick={onScripts}>Roteiro pedido · ver em Roteiros</button>
            ) : (
              <button onClick={() => void act("scriptFromIdea", style.id, i).then((id) => id && setMade([...made, i]))}>
                <Icon name="text" /> Criar roteiro
              </button>
            )}
          </li>
        ))}
      </ul>

      {style.references.length > 0 && (
        <>
          <h3>Vídeos estudados</h3>
          <div className="style-refs">
            {style.references.map((r) => (
              <a key={r.id} href="#" onClick={(e) => (e.preventDefault(), void window.api.openExternal(r.url))} title={r.title}>
                {r.thumb && <img src={r.thumb} alt="" loading="lazy" />}
                <span>{r.title}</span>
                <small>
                  {r.channel} · {big(r.views)}
                </small>
              </a>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

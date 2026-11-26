/**
 * Research agent: what worked on YouTube for a subject, and why.
 * With a YouTube Data API key (or the channel connected) the numbers are exact: views, age, channel size, likes, comments.
 * From them it works out views per day, views per subscriber and engagement, and picks the videos that did
 * unusually well for the size of their channel. Without the API it reads the open web and says how sure it is.
 */
const DAY = 24 * 3600_000;

const ROLE = `You are the Research agent. Given a video topic, find YouTube videos on the same subject that performed unusually well and work out why.
When the task brings "Verified data" from the YouTube Data API, those numbers are exact: pick your references from that list, keep each "id" exactly as given, never change a number, and reason from them (a small channel with many views per subscriber teaches more than a big channel with ordinary numbers).
You may use web search and page fetches to learn how those videos open (the hook), how they are structured and what their thumbnails look like, and to add strong references the list lacks (with "id": null).
Prefer videos in the creator's language (Brazilian Portuguese) and add strong foreign references when they teach something.
Never invent a video, channel or number: leave a field null when you could not see it.

Reply with:
{
  "summary": "3-5 sentences: what works for this topic",
  "references": [{ "id": null, "title": "", "channel": "", "url": "", "views": null, "published": null, "duration_seconds": null, "why_it_worked": "" }],
  "patterns": {
    "hooks": ["how the first 30 seconds usually open, with examples"],
    "titles": ["title formulas that recur"],
    "structure": "how these videos are organised",
    "tone": "the humour or emotion the audience responded to",
    "duration": "typical length",
    "thumbnails": "what the thumbnails have in common"
  },
  "recommendations": { "script": [""], "editing": [""], "thumbnail": [""], "title": [""] },
  "confidence": "alta | média | baixa",
  "limits": "what could not be verified"
}`;

const round = (n, digits = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** digits) / 10 ** digits);

/** Where a value sits among the others, 0 to 1. */
function rank(values, value) {
  const known = values.filter((v) => v != null);
  if (value == null || known.length < 2) return 0.5;
  return known.filter((v) => v < value).length / (known.length - 1);
}

/** Exact numbers for videos on the subject, ordered by how far above their channel's size they went. */
async function gather(ctx, { topic, format }) {
  const yt = ctx.youtube;
  if (!yt?.canRead()) return null;
  const query = String(topic).replace(/\s+/g, " ").slice(0, 90);
  const short = format === "short";
  const found = new Map();
  // Two of the 100 searches a day: what YouTube finds most relevant, and what was most watched in the last year.
  for (const params of [{ order: "relevance" }, { order: "viewCount", publishedAfter: new Date(Date.now() - 365 * DAY).toISOString() }]) {
    for (const v of await yt.search({ query, short, language: ctx.settings.cut.language === "auto" ? "pt" : ctx.settings.cut.language, max: 25, ...params })) if (v.views != null && v.published) found.set(v.id, v);
  }
  const rows = [...found.values()].map((v) => {
    const days = Math.max(1, (Date.now() - new Date(v.published).getTime()) / DAY);
    return {
      ...v,
      days: Math.round(days),
      viewsPerDay: round(v.views / days, 1),
      viewsPerSubscriber: v.subscribers ? round(v.views / v.subscribers, 2) : null,
      engagement: v.views ? round(((v.likes ?? 0) + (v.comments ?? 0)) / v.views, 4) : null,
    };
  });
  if (!rows.length) return null;
  const perDay = rows.map((r) => r.viewsPerDay);
  const perSub = rows.map((r) => r.viewsPerSubscriber);
  const engaged = rows.map((r) => r.engagement);
  for (const r of rows) r.score = round(rank(perSub, r.viewsPerSubscriber) * 0.45 + rank(perDay, r.viewsPerDay) * 0.4 + rank(engaged, r.engagement) * 0.15, 3);
  rows.sort((a, b) => b.score - a.score);
  const top = rows.slice(0, 14);
  // When the videos that did well went out, in Brasília time: one input for choosing an upload time later.
  const timing = { days: Array(7).fill(0), hours: Array(24).fill(0) };
  for (const r of top) {
    const local = new Date(new Date(r.published).toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    timing.days[local.getDay()] += 1;
    timing.hours[local.getHours()] += 1;
  }
  return { top, total: rows.length, timing };
}

async function run(ctx, { topic, tone, format }) {
  ctx.log("info", `Pesquisando o que funcionou em vídeos sobre "${topic}".`);
  let data = null;
  try {
    data = await gather(ctx, { topic, format });
    if (data) ctx.log("info", `YouTube Data API: ${data.total} vídeos sobre o tema, ${data.top.length} com desempenho acima do tamanho do canal.`);
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    ctx.log("warn", `YouTube Data API indisponível (${err.message}). Sigo pela web, com números sem verificação.`);
  }
  const table = data
    ? `\n\nVerified data (YouTube Data API, exact as of today), best first:\n${data.top
        .map(
          (r) =>
            `- id ${r.id} | "${r.title}" | ${r.channel} (${r.subscribers == null ? "subscribers hidden" : `${r.subscribers} subscribers`}) | ${r.views} views in ${r.days} days = ${r.viewsPerDay}/day | ${r.viewsPerSubscriber == null ? "?" : r.viewsPerSubscriber} views per subscriber | engagement ${r.engagement == null ? "?" : `${(r.engagement * 100).toFixed(2)}%`} | ${Math.round(r.duration / 60)} min | published ${r.published.slice(0, 10)}${r.tags.length ? ` | tags: ${r.tags.slice(0, 8).join(", ")}` : ""}`,
        )
        .join("\n")}`
    : "";
  const { json } = await ctx.llm.ask({
    role: ROLE,
    tools: ["WebSearch", "WebFetch"],
    model: ctx.settings.models.research,
    signal: ctx.signal,
    onEvent: (text) => ctx.log("info", text),
    prompt: `Topic: ${topic}\nDesired tone: ${tone}\nFormat: ${format === "short" ? "Short (vertical, up to 60 seconds)" : "long video"}\nChannel niche: ${ctx.settings.channel.niche || "not informed"}${table}\n\n${data ? "Choose 5 to 8 references, mostly from the verified list, and report." : "Find 5 to 8 references and report."}`,
  });
  const references = (Array.isArray(json.references) ? json.references : [])
    .filter((r) => r && r.title)
    .map((r) => {
      // The numbers shown to the creator come from the API, never from what the model wrote back.
      const exact = data?.top.find((t) => t.id === r.id || (r.url && String(r.url).includes(t.id)));
      if (!exact) return { ...r, id: null, verified: false };
      return {
        ...r,
        id: exact.id,
        title: exact.title,
        channel: exact.channel,
        url: exact.url,
        views: exact.views,
        published: exact.published,
        duration_seconds: exact.duration,
        subscribers: exact.subscribers,
        views_per_day: exact.viewsPerDay,
        views_per_subscriber: exact.viewsPerSubscriber,
        engagement: exact.engagement,
        thumb: exact.thumb,
        verified: true,
      };
    });
  const verified = references.filter((r) => r.verified).length;
  ctx.log("decision", `Pesquisa concluída com ${references.length} referências${data ? ` (${verified} com números exatos da API)` : ""}, confiança ${json.confidence ?? "não informada"}. ${json.limits ? `Limites: ${json.limits}` : ""}`);
  return { ...json, references, source: data ? "api" : "web", timing: data?.timing ?? null };
}

module.exports = { run };

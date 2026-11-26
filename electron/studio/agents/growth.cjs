/**
 * Growth agent: tips on what to record and post to get more views, from the creator's own numbers (when the channel
 * is connected), the recordings in the studio, and what is rising in the Trends tab. It only advises: every video it
 * suggests becomes a script or a Short only when the creator clicks, and nothing is ever sent by it.
 */
const DAY = 24 * 3600_000;
const clock = (s) => `${Math.floor((s ?? 0) / 60)}:${String(Math.floor((s ?? 0) % 60)).padStart(2, "0")}`;

const ROLE = `You are the Growth agent of a YouTube creator who records gameplay and talks over it, in Brazilian Portuguese. Your job: tell them, concretely, which videos and Shorts to make next to get more views on THEIR channel.
You get the channel's own numbers when it is connected (latest uploads with views per day, last 28 days), the recordings waiting in their studio (with the moments the Cut agent suggested as Shorts), and what was researched in the Trends tab (the most watched videos on subjects, recurring terms, studied styles).
Base every claim on these numbers and say which one. Compare their videos with each other: what got more views per day than their median, which length, which subject, Shorts vs long videos. Never invent a number. You may search the web to check what is rising for their games now.
Shorts from long videos are the cheapest growth: when a recording has good unmade Short moments, say so.
Write for the creator in Brazilian Portuguese, short and direct, like a friend who understands YouTube.
When you say where to do something, use the studio's own names: the tabs Painel, Crescer (this page: its "Gerar Shorts" button has the Shorts agent make the best moments of a recording, plus a Story), Tendências, Cortes, Roteiros (its ideas have "Criar roteiro"), Shorts and Canal. Never call them Cut, Trends or Research.

Reply with JSON only:
{
  "diagnosis": "3-5 sentences: where the channel stands and the biggest opportunity",
  "working": ["what already works on the channel, with the numbers"],
  "tips": [{ "title": "short action", "why": "the evidence", "how": "how to do it in this studio or on YouTube" }],
  "ideas": [{ "title": "video title", "format": "long | short", "why": "why it should bring views now", "hook": "first seconds, in the creator's voice", "game": "" }],
  "shorts": [{ "videoId": 0, "why": "why make Shorts of this recording now" }],
  "research": ["subjects worth searching in the Trends tab next"],
  "rhythm": "how often to post long videos and Shorts, given their numbers",
  "confidence": "alta | média | baixa",
  "limits": "what could not be seen"
}`;

/** The channel's uploads told apart: long videos and Shorts, each against its own median. */
function describeUploads(uploads) {
  const rows = uploads
    .filter((v) => v.views != null && v.published)
    .map((v) => ({ ...v, perDay: v.views / Math.max(1, (Date.now() - new Date(v.published).getTime()) / DAY), short: (v.duration ?? 0) <= 180 }));
  const median = (list) => {
    const s = list.map((r) => r.perDay).sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };
  const longs = rows.filter((r) => !r.short);
  const shorts = rows.filter((r) => r.short);
  const line = (r, m) => `- "${r.title}" | ${r.short ? "Short" : "long"} ${clock(r.duration)} | ${r.views} views | ${r.perDay.toFixed(1)}/day (${m ? `${(r.perDay / m).toFixed(1)}x median` : "?"}) | ${String(r.published).slice(0, 10)}`;
  return [
    `Long videos: ${longs.length}, median ${median(longs).toFixed(1)} views/day. Shorts: ${shorts.length}, median ${median(shorts).toFixed(1)} views/day.`,
    ...longs.slice(0, 25).map((r) => line(r, median(longs))),
    ...shorts.slice(0, 20).map((r) => line(r, median(shorts))),
  ].join("\n");
}

async function run(ctx, { overview, recordings, trends }) {
  ctx.log("info", "Analisando o canal e as tendências para sugerir os próximos vídeos.");
  const days = overview?.days ?? [];
  const sum = (k) => days.reduce((s, d) => s + (d[k] ?? 0), 0);
  const prompt = [
    `Channel niche: ${ctx.settings.channel?.niche || "not informed"}`,
    "",
    "## The channel",
    overview?.connected
      ? [
          `"${overview.channel?.title}": ${overview.channel?.subscribers ?? "?"} subscribers, ${overview.channel?.views ?? "?"} views, ${overview.channel?.videos ?? "?"} videos.`,
          days.length ? `Last ${days.length} days: ${sum("views")} views, ${Math.round(sum("estimatedMinutesWatched"))} minutes watched, ${sum("subscribersGained") - sum("subscribersLost")} subscribers net.` : "No daily analytics.",
          overview.times ? `Best posting days: ${overview.times.bestDays.map((d) => d.name).join(", ")}; hours: ${overview.times.bestHours.join(", ")}h (${overview.times.basis}).` : "",
          "",
          describeUploads(overview.uploads ?? []),
        ].join("\n")
      : "Not connected: no channel numbers. Say so and lean on the trends.",
    "",
    "## Recordings in the studio",
    ...(recordings.length
      ? recordings.map((r) => `- videoId ${r.id} | "${r.title}" | ${clock(r.duration)} | ${r.status}${r.published ? " | already on YouTube" : ""} | Short moments suggested: ${r.ideas} (best score ${r.best ?? "-"}), already made: ${r.made}`)
      : ["none"]),
    "",
    "## Researched in Trends",
    ...(trends.searches.length
      ? trends.searches.slice(0, 5).map((s) => `- "${s.topic}" (${s.days ? `last ${s.days} days` : "any time"}): terms ${s.insights.terms.slice(0, 8).map((t) => t.term).join(", ") || "-"}; top: ${s.videos.slice(0, 4).map((v) => `"${v.title}" ${v.views} views ${v.viewsPerSubscriber ?? "?"}x channel`).join("; ")}`)
      : ["nothing searched yet"]),
    ...trends.styles.slice(0, 4).map((s) => `- style "${s.name}" on "${s.topic}": ${s.summary.slice(0, 300)} Ideas: ${s.ideas.slice(0, 5).map((i) => i.title).join("; ")}`),
    "",
    "## The creator's voice",
    ctx.voice?.text || "No profile yet.",
    "",
    "Give 5 to 8 tips, 6 to 10 ideas and the recordings worth turning into Shorts now.",
  ].join("\n");
  const { json } = await ctx.llm.ask({ role: ROLE, tools: ["WebSearch", "WebFetch"], model: ctx.settings.models.research, signal: ctx.signal, onEvent: (text) => ctx.log("info", text), prompt });
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()) : []);
  const ids = new Set(recordings.map((r) => r.id));
  const out = {
    at: Date.now(),
    connected: Boolean(overview?.connected),
    diagnosis: String(json.diagnosis ?? ""),
    working: list(json.working),
    tips: (Array.isArray(json.tips) ? json.tips : []).filter((t) => t?.title).map((t) => ({ title: String(t.title), why: String(t.why ?? ""), how: String(t.how ?? "") })),
    ideas: (Array.isArray(json.ideas) ? json.ideas : []).filter((i) => i?.title).map((i) => ({ title: String(i.title), format: i.format === "short" ? "short" : "long", why: String(i.why ?? ""), hook: String(i.hook ?? ""), game: String(i.game ?? "") })),
    shorts: (Array.isArray(json.shorts) ? json.shorts : []).filter((s) => ids.has(Number(s?.videoId))).map((s) => ({ videoId: Number(s.videoId), why: String(s.why ?? "") })),
    research: list(json.research),
    rhythm: String(json.rhythm ?? ""),
    confidence: String(json.confidence ?? ""),
    limits: String(json.limits ?? ""),
  };
  ctx.log("decision", `Dicas para crescer: ${out.tips.length} dicas, ${out.ideas.length} ideias de vídeo, ${out.shorts.length} gravação(ões) para virar Shorts.`);
  return out;
}

module.exports = { run };

/**
 * Metadata agent: what YouTube shows around the video. Titles to choose from, the description, tags and chapters.
 * It only writes text. The creator reads and changes it in the review, and it is part of what they approve.
 */
const edit = require("./edit.cjs");

const CATEGORIES = { 1: "Filmes e animação", 2: "Automóveis", 10: "Música", 15: "Animais", 17: "Esportes", 19: "Viagens e eventos", 20: "Jogos", 22: "Pessoas e blogs", 23: "Comédia", 24: "Entretenimento", 25: "Notícias e política", 26: "Guias e estilo", 27: "Educação", 28: "Ciência e tecnologia" };

const ROLE = `You are the Metadata agent. You write what YouTube shows around one finished video: title options, description, tags and chapters.
You receive the transcript of the FINAL video with times, and sometimes research about what worked for this subject.

Rules:
- Everything in Brazilian Portuguese, in the creator's own voice as heard in the transcript. No clickbait that the video does not deliver.
- titles: 5 different options, each at most 70 characters, the strongest first. Use the title patterns from the research when given.
- description: 2 to 4 short paragraphs. The first two lines must say what the video is and carry the main search terms, because that is what shows before "mais". Do not include chapters, hashtags, links, credits or calls to follow social networks you were not told about: the program adds chapters and credits itself.
- tags: 10 to 15 search terms a viewer would type, most specific first, no "#".
- hashtags: exactly 3, without "#", no spaces.
- chapters: one per real subject change, 3 to 12 of them, first at 0. "time" is in seconds of the final video and must be a time where that subject starts in the transcript. Titles of at most 40 characters. Chapters at least 15 seconds apart. If the video is shorter than 2 minutes or has a single subject, return [].
- category: one of these numbers: ${Object.entries(CATEGORIES).map(([id, name]) => `${id} (${name})`).join(", ")}.

Reply with:
{ "titles": [""], "description": "", "tags": [""], "hashtags": [""], "chapters": [{ "time": 0, "title": "" }], "category": 22, "notes": "one sentence to the creator about the choices" }`;

const clock = (seconds) => {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(s % 60).padStart(2, "0")}`;
};
/** YouTube refuses < and > in titles and descriptions. */
const clean = (text) => String(text ?? "").replace(/[<>]/g, "").replace(/\r/g, "").trim();
const cleanTitle = (text) => clean(text).replace(/\s+/g, " ").slice(0, 100);

/** Tags count against 500 characters together; a tag with a space also counts its two quotes. */
function fitTags(tags) {
  const out = [];
  let used = 0;
  for (const raw of tags ?? []) {
    const tag = clean(raw).replace(/^#/, "").replace(/[,"]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!tag || out.some((t) => t.toLowerCase() === tag.toLowerCase())) continue;
    const cost = tag.length + (tag.includes(" ") ? 2 : 0) + (out.length ? 1 : 0);
    if (used + cost > 480) break;
    used += cost;
    out.push(tag);
  }
  return out;
}

/** The transcript of what stays in the video, in lines of about 12 seconds, with final times. */
function transcriptLines(dir, cuts) {
  const toFinal = edit.timeline(cuts);
  const lines = [];
  let line = null;
  for (const w of edit.keptWords(edit.readWords(dir), cuts)) {
    const at = toFinal((w.start + w.end) / 2);
    if (at === null) continue;
    if (!line || at - line.start > 12) lines.push((line = { start: at, words: [] }));
    line.words.push(String(w.text ?? w.word ?? "").trim());
  }
  return lines.map((l) => `[${clock(l.start)} = ${Math.round(l.start)}s] ${l.words.join(" ")}`);
}

/**
 * The description as it will be sent: the text, then chapters at their place in the video as it is now, then credits and hashtags.
 * Called again whenever the cuts or the music change, so chapter times never go stale.
 */
function compose(meta, { cuts = [], credits = [] } = {}) {
  const toFinal = edit.timeline(cuts);
  let chapters = (meta.chapters ?? [])
    .map((c) => ({ time: toFinal(c.time), title: clean(c.title).slice(0, 60) }))
    .filter((c) => c.time !== null && c.title)
    .sort((a, b) => a.time - b.time)
    .filter((c, i, list) => i === 0 || c.time - list[i - 1].time >= 10);
  // YouTube only shows chapters when the first is at 0:00 and there are at least three.
  if (chapters.length) chapters[0].time = 0;
  if (chapters.length < 3 || meta.useChapters === false) chapters = [];
  const owed = credits.filter((c) => c.needsCredit);
  const hashtags = (meta.hashtags ?? []).map((h) => clean(h).replace(/[#\s]/g, "")).filter(Boolean).slice(0, 3);
  const blocks = [
    clean(meta.body),
    chapters.length ? chapters.map((c) => `${clock(c.time)} ${c.title}`).join("\n") : "",
    owed.length ? `Créditos:\n${owed.map((c) => `${c.kind} "${c.title}" de ${c.creator} (${c.license})${c.url ? ` ${c.url}` : ""}`).join("\n")}` : "",
    hashtags.map((h) => `#${h}`).join(" "),
  ].filter(Boolean);
  return { ...meta, title: cleanTitle(meta.title), tags: fitTags(meta.tags), hashtags, chapterLines: chapters, description: blocks.join("\n\n").slice(0, 4900) };
}

async function run(ctx) {
  const { video, dir, research = null, scriptTitles = [] } = ctx;
  const cuts = video.data.cuts ?? [];
  const lines = transcriptLines(dir, cuts);
  const toOriginal = edit.original(cuts);
  const fallback = { title: cleanTitle(scriptTitles[0] ?? video.title), titles: [cleanTitle(scriptTitles[0] ?? video.title)], body: clean(video.data.summary ?? ""), tags: [], hashtags: [], chapters: [], useChapters: true, category: 22, language: ctx.settings.cut.language === "auto" ? "pt-BR" : ctx.settings.cut.language === "pt" ? "pt-BR" : ctx.settings.cut.language, notes: "" };
  if (!lines.length) {
    ctx.log("warn", "Sem transcrição: título e descrição ficaram para você preencher na revisão.");
    return fallback;
  }
  let json;
  try {
    ({ json } = await ctx.llm.ask({
      role: ROLE,
      model: ctx.settings.models.metadata,
      signal: ctx.signal,
      prompt: [
        `Channel niche: ${ctx.settings.channel.niche || "not informed"}`,
        `File name of the recording: ${video.title}`,
        ctx.brief ? `Creator's instructions for this video (follow what concerns title, description, tags and chapters; the rest is for other agents): ${ctx.brief}` : "",
        ctx.siblings?.length ? `Other videos of the same series already have these titles. Give this one a title of its own, about what happens in it, not a variation of them:\n${ctx.siblings.map((s) => `- ${s}`).join("\n")}` : "",
        video.data.summary ? `Summary from the Cut agent: ${video.data.summary}` : "",
        scriptTitles.length ? `Titles proposed with the script (the creator approved the script): ${scriptTitles.join(" | ")}` : "",
        research?.patterns?.titles ? `Title patterns that worked for this subject (research): ${[].concat(research.patterns.titles).join(" | ")}` : "",
        research?.recommendations?.title?.length ? `Research recommendations for the title: ${research.recommendations.title.join(" | ")}` : "",
        research?.references?.length ? `Titles of reference videos that performed well: ${research.references.slice(0, 8).map((r) => `"${r.title}"`).join(", ")}` : "",
        `\nTranscript of the final video (${lines.length} lines):\n${lines.join("\n")}`,
      ]
        .filter(Boolean)
        .join("\n"),
    }));
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    ctx.log("warn", `Não consegui escrever título e descrição (${err.message}). Ficaram para você preencher na revisão.`);
    return fallback;
  }
  const titles = [...new Set((Array.isArray(json.titles) ? json.titles : []).map(cleanTitle).filter(Boolean))].slice(0, 6);
  if (!titles.length) titles.push(fallback.title);
  const meta = {
    ...fallback,
    title: titles[0],
    titles,
    body: clean(json.description) || fallback.body,
    tags: fitTags(json.tags),
    hashtags: (Array.isArray(json.hashtags) ? json.hashtags : []).map((h) => clean(h).replace(/[#\s]/g, "")).filter(Boolean).slice(0, 3),
    // Kept in the original recording's time, so they follow the video when a cut is turned on or off.
    chapters: (Array.isArray(json.chapters) ? json.chapters : [])
      .map((c) => ({ time: Math.round(toOriginal(Math.max(0, Number(c?.time) || 0)) * 100) / 100, title: clean(c?.title).slice(0, 60) }))
      .filter((c) => c.title),
    category: CATEGORIES[Number(json.category)] ? Number(json.category) : 22,
    notes: clean(json.notes).slice(0, 300),
  };
  ctx.log("decision", `Título sugerido: "${meta.title}" (mais ${titles.length - 1} opções), ${meta.tags.length} tags, ${meta.chapters.length} capítulos. ${meta.notes}`);
  return meta;
}

module.exports = { run, compose, cleanTitle, clean, fitTags, CATEGORIES };

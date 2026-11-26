/**
 * Trends: the most watched videos on a subject (exact numbers from the YouTube Data API), what they have in common
 * (worked out here, no AI), and a style guide the AI writes from them: how they open, how they are structured, how
 * they are edited, their titles and thumbnails, plus ideas of videos to record.
 *
 * The AI does not watch YouTube videos: it sees their numbers, titles, descriptions and thumbnails. How a video is
 * edited (how often it cuts, captions, zooms, pace of speech) is measured only from reference files the creator
 * adds from their own computer.
 */
const fs = require("node:fs");
const path = require("node:path");
const { ff } = require("../ffmpeg.cjs");
const visual = require("../visual.cjs");

const DAY = 24 * 3600_000;
const round = (n, digits = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** digits) / 10 ** digits);
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const STOP = new Set(
  `a o e é de da do das dos em no na nos nas um uma uns umas para pra pro por com sem que se sua seu suas seus meu minha
  mais muito muita como quando onde qual quem isso esse essa este esta isto aqui ali já não nao sim ou mas até ate ao aos à às
  the of and to in on for with is are was my your you this that it vs x ep parte part video vídeo vídeos videos ft feat
  eu ele ela eles elas nós voce você vocês tudo todo toda todos todas new novo nova shorts short`.split(/\s+/),
);

/** Words and pairs of words that recur in the titles of the most watched, the subject's own words left out. */
function terms(rows, query) {
  const own = new Set(words(query));
  const score = new Map();
  rows.forEach((r, i) => {
    const weight = 1 + (rows.length - i) / rows.length;
    const list = words(r.title).filter((w) => !own.has(w));
    const seen = new Set();
    for (let k = 0; k < list.length; k++) {
      for (const t of [list[k], k + 1 < list.length ? `${list[k]} ${list[k + 1]}` : null]) {
        if (!t || seen.has(t)) continue;
        seen.add(t);
        score.set(t, (score.get(t) ?? 0) + weight);
      }
    }
    for (const tag of r.tags ?? []) {
      const t = tag.toLowerCase().trim();
      if (t && !own.has(t) && t.length < 30 && !seen.has(t)) score.set(t, (score.get(t) ?? 0) + weight * 0.5);
    }
  });
  const counts = (t) => rows.filter((r) => `${r.title} ${(r.tags ?? []).join(" ")}`.toLowerCase().includes(t)).length;
  return [...score.entries()]
    .filter(([t]) => counts(t) >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 14)
    .map(([t]) => ({ term: t, videos: counts(t) }));
}

function words(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
}

const median = (list) => {
  const v = list.filter((x) => x != null).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};

/** What the most watched have in common, counted. */
function insights(rows, query) {
  const top = rows.slice(0, 20);
  const timing = { days: Array(7).fill(0), hours: Array(24).fill(0) };
  for (const r of top) {
    const local = new Date(new Date(r.published).toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    timing.days[local.getDay()] += 1;
    timing.hours[local.getHours()] += 1;
  }
  const share = (test) => (top.length ? Math.round((top.filter(test).length / top.length) * 100) : 0);
  return {
    terms: terms(rows.slice(0, 30), query),
    duration: { median: median(top.slice(0, 10).map((r) => r.duration)), short: share((r) => r.duration <= 240), long: share((r) => r.duration >= 1200) },
    titles: {
      length: median(top.map((r) => r.title.length)),
      question: share((r) => r.title.includes("?")),
      number: share((r) => /\d/.test(r.title)),
      caps: share((r) => /\b[A-ZÁÉÍÓÚÂÊÔÃÕÇ]{3,}\b/.test(r.title)),
      emoji: share((r) => /\p{Extended_Pictographic}/u.test(r.title)),
    },
    outliers: rows.filter((r) => r.viewsPerSubscriber != null && r.viewsPerSubscriber >= 3).length,
    timing,
  };
}

/**
 * The most watched videos about `topic` published in the last `days` days (null: any time).
 * One search ordered by views and one by relevance: 2 of the 100 searches the API allows per day.
 */
async function search(ctx, { topic, days = 30, format = "all" }) {
  const yt = ctx.youtube;
  if (!yt?.canRead()) throw new Error("Para pesquisar no YouTube, coloque a chave da YouTube Data API ou conecte o canal em Configurações → YouTube.");
  const query = String(topic ?? "").replace(/\s+/g, " ").trim().slice(0, 90);
  if (!query) throw new Error("Escreva um assunto para pesquisar.");
  const language = ctx.settings.cut.language === "auto" ? "pt" : ctx.settings.cut.language || "pt";
  const publishedAfter = days ? new Date(Date.now() - days * DAY).toISOString() : null;
  const short = format === "short";
  const found = new Map();
  for (const order of ["viewCount", "relevance"]) {
    for (const v of await yt.search({ query, order, publishedAfter, language, max: 50, short })) if (v.views != null && v.published) found.set(v.id, v);
  }
  let rows = [...found.values()];
  if (format === "long") rows = rows.filter((r) => r.duration >= 240);
  rows = rows.map((v) => {
    const age = Math.max(1, (Date.now() - new Date(v.published).getTime()) / DAY);
    return {
      id: v.id,
      url: v.url,
      title: v.title,
      channel: v.channel,
      channelId: v.channelId,
      published: v.published,
      description: v.description,
      tags: v.tags,
      thumb: v.thumb,
      duration: v.duration,
      views: v.views,
      likes: v.likes,
      comments: v.comments,
      subscribers: v.subscribers,
      days: Math.round(age),
      viewsPerDay: round(v.views / age, 1),
      viewsPerSubscriber: v.subscribers ? round(v.views / v.subscribers, 2) : null,
      engagement: v.views ? round(((v.likes ?? 0) + (v.comments ?? 0)) / v.views, 4) : null,
    };
  });
  rows.sort((a, b) => b.views - a.views);
  ctx.log("info", `Tendências de "${query}": ${rows.length} vídeos${days ? ` dos últimos ${days} dias` : ""}, o mais visto com ${rows[0]?.views ?? 0} visualizações.`);
  return { at: Date.now(), topic: query, days: days ?? null, format, videos: rows, insights: insights(rows, query) };
}

// --- Studying a style ----------------------------------------------------------------------------------

async function download(url, file, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(String(res.status));
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

async function probe(file) {
  const { FFPROBE } = require("../../media.cjs");
  const { execFile } = require("node:child_process");
  return new Promise((resolve, reject) =>
    execFile(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", file], { windowsHide: true, maxBuffer: 1e7 }, (err, out) => {
      if (err) return reject(new Error(`Não consegui ler ${path.basename(file)}.`));
      const info = JSON.parse(out);
      const picture = info.streams.find((s) => s.codec_type === "video");
      resolve({ duration: Number(info.format?.duration ?? 0), width: picture?.width ?? 0, height: picture?.height ?? 0, sound: info.streams.some((s) => s.codec_type === "audio") });
    }),
  );
}

/**
 * A reference video from the creator's computer, measured: how often the picture changes (cuts), how much moves,
 * how fast and how much is spoken, what is said in the first minutes, and a sheet of frames to see captions,
 * zooms, facecam and overlays.
 */
async function measureFile(ctx, file, dir, transcribe) {
  const name = path.basename(file);
  const info = await probe(file);
  if (!info.duration) throw new Error(`${name} não tem vídeo que eu consiga ler.`);
  ctx.log("info", `Medindo o vídeo de referência ${name} (${clock(info.duration)}).`);
  const out = { file: name, duration: round(info.duration, 1), width: info.width, height: info.height, vertical: info.height > info.width };
  const measured = await visual.analyse(file, info.duration, { dir, signal: ctx.signal }).catch((err) => {
    if (ctx.signal.aborted) throw err;
    ctx.log("warn", `Não consegui medir a imagem de ${name}: ${err.message}`);
    return null;
  });
  if (measured) {
    const cuts = measured.sceneCuts?.length ?? 0;
    out.cutsPerMinute = round((cuts / info.duration) * 60, 1);
    out.averageShotSeconds = round(info.duration / (cuts + 1), 1);
    out.actionShare = round(visual.actionShare(measured, 0, info.duration), 2);
    out.stillSeconds = Math.round((measured.still ?? []).reduce((sum, r) => sum + r.end - r.start, 0));
    // Where the cuts fall in the first minute shows how hard the opening is edited.
    out.cutsFirstMinute = (measured.sceneCuts ?? []).filter((t) => t < 60).length;
  }
  // Six frames across the video, side by side, for the AI to look at.
  const sheet = path.join(dir, "quadros.jpg");
  const times = [0.04, 0.15, 0.3, 0.5, 0.7, 0.9].map((p) => p * info.duration);
  const frames = [];
  for (const [i, t] of times.entries()) {
    const frame = path.join(dir, `q${i}.jpg`);
    await ff(["-ss", t.toFixed(2), "-i", file, "-frames:v", "1", "-vf", "scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2", frame], { signal: ctx.signal }).catch(() => {});
    if (fs.existsSync(frame)) frames.push(frame);
  }
  if (frames.length) {
    await ff([...frames.flatMap((f) => ["-i", f]), "-filter_complex", `${frames.map((_, i) => `[${i}]`).join("")}xstack=inputs=${frames.length}:layout=${frames.map((_, i) => `${(i % 3) * 480}_${Math.floor(i / 3) * 270}`).join("|")}:fill=black`, "-frames:v", "1", sheet], { signal: ctx.signal }).catch(() => {});
    if (fs.existsSync(sheet)) out.frames = sheet;
  }
  // What is said in the first minutes: the hook and how the script moves.
  if (info.sound && transcribe) {
    const audio = path.join(dir, "inicio.wav");
    const span = Math.min(info.duration, 300);
    try {
      await ff(["-i", file, "-t", String(span), "-vn", "-ac", "1", "-ar", "16000", audio], { signal: ctx.signal });
      const { words } = await transcribe({ path: audio, duration: span, language: ctx.settings.cut.language || null, quality: ctx.settings.cut.quality, device: "auto" });
      const spoken = words.reduce((sum, w) => sum + (w.end - w.start), 0);
      out.wordsPerMinute = Math.round((words.length / span) * 60);
      out.speechShare = round(spoken / span, 2);
      const text = (from, to) => words.filter((w) => w.start >= from && w.start < to).map((w) => w.word ?? w.text ?? "").join(" ").replace(/\s+/g, " ").trim();
      out.hook = text(0, 30);
      out.opening = text(0, span).slice(0, 3500);
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.log("warn", `Não consegui transcrever ${name}: ${err.message}`);
    }
  }
  ctx.log("info", `${name}: ${out.cutsPerMinute ?? "?"} cortes por minuto, um plano a cada ${out.averageShotSeconds ?? "?"} s${out.wordsPerMinute ? `, ${out.wordsPerMinute} palavras por minuto` : ""}.`);
  return out;
}

const STYLE_ROLE = `You are the Trends agent of a YouTube creator who records gameplay and talks over it, in Brazilian Portuguese. You study the most watched videos on a subject and write a style guide the creator's editor (another AI that edits the timeline) and script writer will follow, plus ideas of videos to record.
What you get:
- Exact numbers from the YouTube Data API (views, views per day, views per subscriber, length, date, tags, description). Never change a number or invent a video.
- The thumbnails of the chosen videos as image files: Read them.
- Sometimes reference video files the creator has on their computer, MEASURED here: cuts per minute, average shot length, how much moves on screen, words per minute, the transcript of the first minutes and a sheet of 6 frames (Read it to see captions, zooms, facecam, overlays, memes).
You cannot watch YouTube videos. Editing advice (cut rhythm, zooms, captions, sounds) is only "measured" when it comes from the reference files; otherwise say it is inferred from titles, descriptions and thumbnails, and keep it general. You may use web search and page fetches to learn more about these videos and what is rising on the subject (do not fetch video files).
Write everything for the creator in Brazilian Portuguese, short and concrete. Editing rules must be things an editor can apply on a timeline ("um corte a cada 2–3 s nos primeiros 30 s", "legenda amarela grande nas frases de impacto", "zoom de 110% nas reações").
The ideas are videos THIS creator could record: say why each one should work now (the numbers or trend behind it), and the hook of the first seconds.

Reply with JSON only:
{
  "name": "short name for this style, 2-4 words",
  "summary": "3-5 sentences: what the most watched videos on this subject do",
  "script": { "hook": "how the first 5-30 seconds open, with an example in the creator's voice", "structure": ["the parts in order, with rough times"], "retention": ["what keeps people watching"], "cta": "how they ask to subscribe/comment", "tone": "" },
  "editing": { "measured": true, "pace": "", "cutEverySeconds": null, "captions": "", "zooms": "", "music": "", "sounds": "", "overlays": "", "transitions": "", "rules": ["concrete rules for the editor"] },
  "titles": { "formulas": [""], "examples": ["titles for the creator's next video on this subject"] },
  "thumbnails": "what the thumbnails have in common and what to put in the creator's",
  "duration": "the length that works and why",
  "posting": "when they go out, if the numbers show it",
  "trends": ["what is rising on this subject now, with the evidence"],
  "ideas": [{ "title": "", "format": "long | short", "why": "", "hook": "", "based_on": ["video ids"] }],
  "confidence": "alta | média | baixa",
  "limits": "what could not be seen or verified"
}`;

const asList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()) : typeof v === "string" && v.trim() ? [v] : []);

/** Reads the chosen videos (and reference files) and writes a style guide with ideas. */
async function study(ctx, { found, ids, files = [], transcribe, mine = [] }) {
  const picks = found.videos.filter((v) => ids.includes(v.id)).slice(0, 10);
  if (!picks.length && !files.length) throw new Error("Escolha pelo menos um vídeo da lista ou um vídeo de referência do seu computador.");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = path.join(ctx.workspace, "tendencias", stamp);
  fs.mkdirSync(dir, { recursive: true });
  ctx.log("info", `Estudando o estilo de ${picks.length} vídeo(s) do YouTube${files.length ? ` e ${files.length} vídeo(s) de referência do seu computador` : ""}.`);
  const thumbs = [];
  for (const v of picks) {
    const file = path.join(dir, `capa-${v.id}.jpg`);
    await download(`https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`, file, ctx.signal)
      .catch(() => (v.thumb ? download(v.thumb, file, ctx.signal) : null))
      .then(() => fs.existsSync(file) && thumbs.push({ id: v.id, file }))
      .catch(() => {});
  }
  const measured = [];
  for (const [i, file] of files.entries()) {
    const sub = path.join(dir, `referencia-${i + 1}`);
    fs.mkdirSync(sub, { recursive: true });
    try {
      measured.push(await measureFile(ctx, file, sub, transcribe));
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.log("warn", err.message);
    }
  }
  const ins = found.insights;
  const days = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
  const prompt = [
    `Subject: ${found.topic}`,
    `Period searched: ${found.days ? `last ${found.days} days` : "any time"} · format: ${found.format}`,
    `Channel niche: ${ctx.settings.channel?.niche || "not informed"}`,
    "",
    "## Counted on the 20 most watched",
    `Recurring terms: ${ins.terms.map((t) => `${t.term} (${t.videos})`).join(", ") || "none"}`,
    `Median length of the top 10: ${ins.duration.median ? clock(ins.duration.median) : "?"} · up to 4 min: ${ins.duration.short}% · 20 min or more: ${ins.duration.long}%`,
    `Titles: median ${ins.titles.length} characters · question ${ins.titles.question}% · number ${ins.titles.number}% · CAPS word ${ins.titles.caps}% · emoji ${ins.titles.emoji}%`,
    `Days (Brasília): ${ins.timing.days.map((n, i) => `${days[i]} ${n}`).join(", ")} · hours: ${ins.timing.hours.map((n, h) => (n ? `${h}h ${n}` : null)).filter(Boolean).join(", ")}`,
    `Videos with 3x or more views than subscribers: ${ins.outliers}`,
    "",
    "## The most watched (for context)",
    ...found.videos.slice(0, 15).map((r) => `- ${r.id} | "${r.title}" | ${r.channel} | ${r.views} views | ${r.viewsPerDay}/day | ${r.viewsPerSubscriber ?? "?"}x subscribers | ${clock(r.duration)} | ${r.published.slice(0, 10)}`),
    "",
    "## Chosen by the creator to study",
    ...picks.map((r) => `- id ${r.id} | "${r.title}" | ${r.channel} (${r.subscribers ?? "?"} subscribers) | ${r.views} views in ${r.days} days | ${clock(r.duration)}${r.tags?.length ? ` | tags: ${r.tags.slice(0, 10).join(", ")}` : ""}\n  description: ${String(r.description ?? "").replace(/\s+/g, " ").slice(0, 500)}`),
    "",
    "## Thumbnails (Read each file)",
    ...(thumbs.length ? thumbs.map((t) => `- ${t.id}: ${t.file}`) : ["none downloaded"]),
    "",
    "## Reference files measured on the creator's computer",
    ...(measured.length
      ? measured.map((m) =>
          [
            `- ${m.file}: ${clock(m.duration)}, ${m.width}x${m.height}${m.vertical ? " (vertical)" : ""}`,
            `  cuts per minute ${m.cutsPerMinute ?? "?"}, one shot every ${m.averageShotSeconds ?? "?"} s, ${m.cutsFirstMinute ?? "?"} cuts in the first minute, movement on screen ${m.actionShare ?? "?"}, still screens ${m.stillSeconds ?? "?"} s`,
            m.wordsPerMinute ? `  speech: ${m.wordsPerMinute} words per minute, speaking ${Math.round((m.speechShare ?? 0) * 100)}% of the time` : "  speech: not transcribed",
            m.frames ? `  frames sheet (Read it): ${m.frames}` : "",
            m.hook ? `  first 30 s: "${m.hook}"` : "",
            m.opening ? `  first minutes: "${m.opening}"` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        )
      : ["none: editing advice must be marked as inferred (editing.measured = false)"]),
    "",
    "## The creator's own latest videos (to tailor the ideas)",
    ...(mine.length ? mine.slice(0, 12).map((v) => `- "${v.title}" | ${v.views ?? "?"} views | ${clock(v.duration ?? 0)} | ${String(v.published ?? "").slice(0, 10)}`) : ["not connected"]),
    "",
    "## The creator's voice",
    ctx.voice?.text || "No profile yet.",
    "",
    "Write the style guide and 6 to 10 ideas.",
  ].join("\n");
  const { json } = await ctx.llm.ask({
    role: STYLE_ROLE,
    tools: ["Read", "WebSearch", "WebFetch"],
    model: ctx.settings.models.research,
    signal: ctx.signal,
    onEvent: (text) => ctx.log("info", text),
    prompt,
  });
  const ideas = (Array.isArray(json.ideas) ? json.ideas : [])
    .filter((i) => i && i.title)
    .map((i) => ({ title: String(i.title), format: i.format === "short" ? "short" : "long", why: String(i.why ?? ""), hook: String(i.hook ?? ""), basedOn: asList(i.based_on).filter((id) => found.videos.some((v) => v.id === id)) }));
  const editing = json.editing && typeof json.editing === "object" ? json.editing : {};
  const style = {
    id: `est-${Date.now().toString(36)}`,
    created: Date.now(),
    topic: found.topic,
    name: String(json.name || found.topic).slice(0, 60),
    summary: String(json.summary ?? ""),
    script: {
      hook: String(json.script?.hook ?? ""),
      structure: asList(json.script?.structure),
      retention: asList(json.script?.retention),
      cta: String(json.script?.cta ?? ""),
      tone: String(json.script?.tone ?? ""),
    },
    editing: {
      measured: measured.length > 0 && editing.measured !== false,
      pace: String(editing.pace ?? ""),
      cutEverySeconds: Number.isFinite(Number(editing.cutEverySeconds)) && editing.cutEverySeconds !== null ? Number(editing.cutEverySeconds) : null,
      captions: String(editing.captions ?? ""),
      zooms: String(editing.zooms ?? ""),
      music: String(editing.music ?? ""),
      sounds: String(editing.sounds ?? ""),
      overlays: String(editing.overlays ?? ""),
      transitions: String(editing.transitions ?? ""),
      rules: asList(editing.rules),
    },
    titles: { formulas: asList(json.titles?.formulas), examples: asList(json.titles?.examples) },
    thumbnails: String(json.thumbnails ?? ""),
    duration: String(json.duration ?? ""),
    posting: String(json.posting ?? ""),
    trends: asList(json.trends),
    ideas,
    confidence: String(json.confidence ?? ""),
    limits: String(json.limits ?? ""),
    // The numbers stay the API's.
    references: picks.map((r) => ({ id: r.id, title: r.title, channel: r.channel, url: r.url, views: r.views, published: r.published, duration: r.duration, subscribers: r.subscribers, viewsPerDay: r.viewsPerDay, viewsPerSubscriber: r.viewsPerSubscriber, thumb: r.thumb })),
    measured: measured.map(({ frames, opening, ...m }) => m),
  };
  ctx.log("decision", `Estilo "${style.name}" pronto: ${style.editing.rules.length} regras de edição, ${ideas.length} ideias de vídeo${style.editing.measured ? ", ritmo medido nos vídeos de referência" : ", edição deduzida (sem vídeo de referência)"}.`);
  return style;
}

/** The style as instructions for an editor or a script writer. */
function stylePrompt(style) {
  if (!style) return "";
  const lines = [
    `## Style guide to follow: "${style.name}" (studied from the most watched videos about "${style.topic}")`,
    style.summary,
    style.script.hook && `Opening: ${style.script.hook}`,
    style.script.structure.length ? `Structure: ${style.script.structure.join(" → ")}` : "",
    style.script.retention.length ? `Keeps people watching: ${style.script.retention.join("; ")}` : "",
    style.script.tone && `Tone: ${style.script.tone}`,
    style.editing.pace && `Editing pace${style.editing.measured ? " (measured)" : " (inferred)"}: ${style.editing.pace}${style.editing.cutEverySeconds ? ` (a cut about every ${style.editing.cutEverySeconds} s)` : ""}`,
    style.editing.captions && `Captions: ${style.editing.captions}`,
    style.editing.zooms && `Zooms: ${style.editing.zooms}`,
    style.editing.music && `Music: ${style.editing.music}`,
    style.editing.sounds && `Sound effects and memes: ${style.editing.sounds}`,
    style.editing.overlays && `Overlays: ${style.editing.overlays}`,
    style.editing.transitions && `Transitions: ${style.editing.transitions}`,
    style.editing.rules.length ? `Editing rules:\n${style.editing.rules.map((r) => `- ${r}`).join("\n")}` : "",
    style.duration && `Length: ${style.duration}`,
  ];
  return lines.filter(Boolean).join("\n");
}

/** A style written as the research report the Script agent reads. */
function asResearch(style, idea) {
  return {
    summary: style.summary,
    references: style.references.map((r) => ({ id: r.id, title: r.title, channel: r.channel, url: r.url, views: r.views, published: r.published, duration_seconds: r.duration, subscribers: r.subscribers, views_per_day: r.viewsPerDay, views_per_subscriber: r.viewsPerSubscriber, thumb: r.thumb, verified: true, why_it_worked: "" })),
    patterns: { hooks: [style.script.hook, idea?.hook].filter(Boolean), titles: style.titles.formulas, structure: style.script.structure.join(" → "), tone: style.script.tone, duration: style.duration, thumbnails: style.thumbnails },
    recommendations: { script: style.script.retention, editing: style.editing.rules, thumbnail: [style.thumbnails].filter(Boolean), title: style.titles.examples },
    confidence: style.confidence || "média",
    limits: style.limits,
    source: "api",
    style: style.name,
    idea: idea ? { title: idea.title, why: idea.why, hook: idea.hook } : null,
  };
}

module.exports = { search, study, stylePrompt, asResearch };

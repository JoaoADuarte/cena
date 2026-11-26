/**
 * Shorts agent: turns a suggested moment of a recording into a vertical 1080×1920 video, with large captions.
 * It reads the original recording and never writes to it. The result is a separate video that waits for the
 * creator's approval like any other; this agent has no way to send anything anywhere.
 * It also answers requests written by the creator ("um short da parte em que eu caio no buraco").
 */
const fs = require("node:fs");
const path = require("node:path");
const { ff, sdrFilter, withSdr } = require("../ffmpeg.cjs");
const { sentences, clock } = require("./cut.cjs");
const { mergedCuts, readWords } = require("./edit.cjs");

const W = 1080;
const H = 1920;
const FRAMES = ["square", "fill", "fit"];
const MIN = 5;
const MAX = 180;

/** The parts of [start, end] that stay once the cuts that are on are taken out. */
function segments(start, end, cuts) {
  const out = [];
  let at = start;
  for (const c of mergedCuts(cuts)) {
    if (c.end <= at || c.start >= end) continue;
    if (c.start - at >= 0.15) out.push({ start: at, end: c.start });
    at = Math.max(at, c.end);
  }
  if (end - at >= 0.15) out.push({ start: at, end });
  return out.length ? out : [{ start, end }];
}

/** Original time → time inside the short, or null when that moment is not in it. */
function mapper(parts) {
  return (t) => {
    let before = 0;
    for (const p of parts) {
      if (t >= p.start && t <= p.end) return before + t - p.start;
      before += p.end - p.start;
    }
    return null;
  };
}

const assTime = (t) => {
  const s = Math.max(0, t);
  const cs = Math.round(s * 100);
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};
/** "#rrggbb" → ASS "&HBBGGRR&". */
const assColour = (hex) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex ?? ""));
  return m ? `&H${m[3]}${m[2]}${m[1]}&`.toUpperCase() : "&H00D4FF&";
};
const assText = (text) => String(text).replace(/[{}\\]/g, "").replace(/\s+/g, " ").trim();

/** Where the picture, the title and the captions go in each framing. */
function layout(frame, vertical) {
  if (vertical || frame === "fill") return { title: 150, captions: 1330 };
  if (frame === "fit") return { title: 330, captions: 1340 };
  return { title: 150, captions: 1570 };
}

/** The captions file: two or three words at a time, the word being said in the highlight colour. */
function subtitles({ words, parts, total, hook, captions, frame, vertical, font, accent }) {
  const at = layout(frame, vertical);
  const colour = assColour(accent);
  const head = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Cap,${font},92,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,8,3,8,70,70,${at.captions},1`,
    `Style: Title,${font},74,${colour.replace("&H", "&H00").replace(/&$/, "")},&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,7,3,8,70,70,${at.title},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events = [];
  const title = assText(hook ?? "");
  if (title) events.push(`Dialogue: 1,${assTime(0)},${assTime(total)},Title,,0,0,0,,${title.toUpperCase()}`);
  if (captions) {
    const toShort = mapper(parts);
    const said = words
      .map((w) => ({ text: assText(w.text), start: toShort(w.start), end: toShort(Math.min(w.end, w.start + 1.5)) ?? toShort(w.start) }))
      .filter((w) => /[p{L}p{N}]/u.test(w.text) && w.start !== null)
      .map((w) => ({ ...w, end: w.end ?? w.start + 0.3 }));
    const groups = [];
    for (const w of said) {
      const last = groups[groups.length - 1];
      const length = last ? last.reduce((n, x) => n + x.text.length + 1, 0) : 0;
      if (!last || last.length >= 3 || length + w.text.length > 16 || w.start - last[last.length - 1].end > 0.6 || /[.!?]$/.test(last[last.length - 1].text)) groups.push([w]);
      else last.push(w);
    }
    groups.forEach((group, g) => {
      const groupEnd = Math.min(group[group.length - 1].end + 0.35, groups[g + 1]?.[0].start ?? total);
      group.forEach((word, i) => {
        const from = word.start;
        const to = i + 1 < group.length ? group[i + 1].start : groupEnd;
        if (to - from < 0.02) return;
        const line = group.map((x, k) => (k === i ? `{\\c${colour}}${x.text.toUpperCase()}{\\c&HFFFFFF&}` : x.text.toUpperCase())).join(" ");
        events.push(`Dialogue: 0,${assTime(from)},${assTime(to)},Cap,,0,0,0,,${i === 0 ? "{\\fscx88\\fscy88\\t(0,70,\\fscx100\\fscy100)}" : ""}${line}`);
      });
    });
  }
  return [...head, ...events, ""].join("\n");
}

/** The picture part of the filter graph, from [vc] to [vf]. */
function picture({ frame, focus, vertical }) {
  const x = Math.max(0, Math.min(1, Number.isFinite(focus) ? focus : 0.5));
  if (vertical) return `[vc]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[vf]`;
  if (frame === "fill") return `[vc]scale=-2:${H},crop=${W}:${H}:(iw-${W})*${x}:0,setsar=1[vf]`;
  const back = `[bgi]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:2,eq=brightness=-0.18:saturation=1.15[bg]`;
  const front = frame === "fit" ? `[fgi]scale=${W}:-2[fg]` : `[fgi]crop=ih:ih:(iw-ih)*${x}:0,scale=${W}:${W}[fg]`;
  return `[vc]split=2[bgi][fgi];${back};${front};[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[vf]`;
}

/**
 * Renders one short. `item` is { start, end, frame, focus, captions, hook } in the original recording's times.
 * Resolves with { path, cover, duration }.
 */
async function render(ctx, { parent, parentDir, item, dir }) {
  const source = parent.source_path;
  if (!fs.existsSync(source)) throw new Error("A gravação original não foi encontrada.");
  const start = Math.max(0, Number(item.start));
  const end = Math.min(parent.data.duration ?? Infinity, Number(item.end));
  if (!(end - start >= MIN)) throw new Error("O trecho é curto demais para um Short.");
  const parts = segments(start, end, item.tight === false ? [] : parent.data.cuts);
  const total = parts.reduce((sum, p) => sum + p.end - p.start, 0);
  if (total > MAX) throw new Error("O trecho passa de 3 minutos, o limite de um Short.");
  const frame = FRAMES.includes(item.frame) ? item.frame : "square";
  const vertical = (parent.data.height ?? 0) > (parent.data.width ?? 1);
  const clean = parent.data.cleanAudioPath && fs.existsSync(parent.data.cleanAudioPath) ? parent.data.cleanAudioPath : null;

  fs.mkdirSync(dir, { recursive: true });
  ctx.progress(0.02, "Preparando as legendas");
  const words = readWords(parentDir).filter((w) => w.end > start && w.start < end);
  fs.writeFileSync(
    path.join(dir, "legenda.ass"),
    subtitles({ words, parts, total, hook: item.hook, captions: item.captions !== false && words.length > 0, frame, vertical, font: ctx.settings.edit.font || "Arial Black", accent: ctx.settings.edit.textColour }),
  );

  // Both inputs are opened at the start of the moment, so times inside the graph count from there.
  const lead = Math.max(0, start - 0.5);
  // HDR recordings: tone-mapped once, before the pieces are taken.
  const sdr = await sdrFilter(source);
  const sdrV = sdr ? [`[0:v]${sdr},split=${parts.length}${parts.map((_, i) => `[s${i}]`).join("")}`] : [];
  const cutV = parts.map((p, i) => `${sdr ? `[s${i}]` : "[0:v]"}trim=start=${(p.start - lead).toFixed(3)}:end=${(p.end - lead).toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
  // With the voice on its own track (OBS), the cleaned voice is mixed back over the game sound.
  const mixed = Boolean(clean) && (parent.data.audioStreams ?? 1) > 1 && (parent.data.voiceStream ?? 0) !== 0;
  const sound = mixed ? [`[0:a:0]volume=0.6[game];[1:a][game]amix=inputs=2:normalize=0,asplit=${parts.length}${parts.map((_, i) => `[m${i}]`).join("")}`] : [];
  const cutA = parts.map((p, i) => `${mixed ? `[m${i}]` : "[1:a]"}atrim=start=${(p.start - lead).toFixed(3)}:end=${(p.end - lead).toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
  const graph = [
    ...sdrV,
    ...cutV,
    ...sound,
    ...cutA,
    `${parts.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${parts.length}:v=1:a=1[vc][ac]`,
    picture({ frame, focus: Number(item.focus), vertical }),
    "[vf]ass=legenda.ass,format=yuv420p[vout]",
    `[ac]afade=t=in:d=0.08,afade=t=out:st=${Math.max(0, total - 0.25).toFixed(3)}:d=0.25,aresample=48000[aout]`,
  ].join(";");
  const span = (end - lead + 0.5).toFixed(3);
  const out = path.join(dir, "short.mp4");
  const args = (encoder) => [
    "-ss", lead.toFixed(3), "-t", span, "-i", source,
    "-ss", lead.toFixed(3), "-t", span, "-i", clean ?? source,
    "-filter_complex", graph, "-map", "[vout]", "-map", "[aout]",
    ...encoder,
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-t", total.toFixed(3), "short.mp4",
  ];
  const run = (encoder) => ff(args(encoder), { signal: ctx.signal, cwd: dir, total, onProgress: (f) => ctx.progress(0.05 + f * 0.9, "Renderizando o Short") });
  const x264 = ["-c:v", "libx264", "-preset", "medium", "-crf", "19"];
  if (ctx.settings.render.gpu) {
    try {
      await run(["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "21", "-b:v", "0", "-maxrate", "16M", "-bufsize", "32M"]);
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.log("warn", "A placa de vídeo não aceitou este Short. Renderizando pelo processador.");
      await run(x264);
    }
  } else await run(x264);
  if (!fs.existsSync(out) || fs.statSync(out).size < 10_000) throw new Error("O Short não foi gerado.");

  const cover = path.join(dir, "capa.jpg");
  await ff(["-ss", Math.min(1, total / 2).toFixed(2), "-i", out, "-frames:v", "1", "-vf", "scale=540:-2", "-q:v", "3", cover], { signal: ctx.signal }).catch(() => {});
  ctx.log(
    "decision",
    `Short "${item.title}" pronto: ${clock(start)}–${clock(end)} do original, ${Math.round(total)} s${parts.length > 1 ? ` (${parts.length - 1} corte(s) do vídeo aplicados dentro dele)` : ""}, enquadramento ${{ square: "quadrado com fundo desfocado", fill: "tela cheia", fit: "vídeo inteiro com fundo desfocado" }[vertical ? "fill" : frame]}, ${item.captions !== false && words.length ? "com legendas" : "sem legendas"}.`,
  );
  return { path: out, cover: fs.existsSync(cover) ? cover : null, duration: +total.toFixed(2) };
}

const ROLE = `You are the Shorts agent of one YouTube creator. You receive the transcript of a recording (one numbered sentence per line, with its start and end in seconds), the moments already listed as possible vertical Shorts, and a request written by the creator in Brazilian Portuguese.

Do what the request asks, using only what is in the transcript:
- "add": new moments. Each works alone as a Short of 15 to 60 seconds (never more than 170): it starts on a strong line, makes sense without context and ends on a payoff. "from" and "to" are sentence numbers (first and last sentence, inclusive). When the creator gives exact times, use "from_time" and "to_time" in seconds instead. "title" is a YouTube Shorts title in Brazilian Portuguese, at most 70 characters, no clickbait that the moment does not deliver. "hook" is 2 to 5 words to show on screen above the video, or "" for none. "score" from 0 to 100 is how well it should hold a viewer. "reason" is one sentence in Brazilian Portuguese.
- "change": edits to listed moments, by their "id". Only include the fields that change: "from", "to", "from_time", "to_time", "title", "hook", "frame" ("square": square picture over a blurred background; "fill": full-height crop; "fit": whole picture, small, over a blurred background), "captions" (true or false), "focus" (0 = keep the left of the picture, 0.5 = centre, 1 = right).
- "remove": ids of listed moments the creator wants gone.
- "reply": one or two sentences in Brazilian Portuguese saying what you did, or why you could not (for example, the moment asked for is not in the transcript). Never invent a moment that was not said.

You only see what was said, not the picture. If the request depends on something only visible, say so in "reply".

Answer with one JSON object and nothing else:
{ "reply": "", "add": [{ "from": 1, "to": 3, "title": "", "hook": "", "reason": "", "score": 0 }], "change": [{ "id": 1, "title": "" }], "remove": [] }`;

/** Reads the creator's request and returns what to add, change and remove. Times are already in seconds. */
async function ask(ctx, { parent, parentDir, text }) {
  const lines = sentences(readWords(parentDir));
  if (!lines.length) throw new Error("Este vídeo não tem transcrição; sem ela o agente não sabe o que foi dito.");
  const duration = parent.data.duration ?? lines[lines.length - 1].end;
  const { json } = await ctx.llm.ask({
    role: ROLE,
    model: ctx.settings.models.shorts ?? null,
    signal: ctx.signal,
    prompt: [
      `Recording: "${parent.title}", ${clock(duration)} long`,
      parent.data.summary ? `Summary: ${parent.data.summary}` : "",
      ctx.settings.channel.niche ? `Channel: ${ctx.settings.channel.niche}` : "",
      "\n## Moments already listed",
      ...(parent.data.shorts ?? []).map((s) => `id ${s.id}: ${s.start.toFixed(1)}–${s.end.toFixed(1)} s "${s.title}" frame=${s.frame ?? "square"} captions=${s.captions !== false} hook="${s.hook ?? ""}"`),
      (parent.data.shorts ?? []).length ? "" : "(none)",
      "\n## Transcript",
      ...lines.map((s) => `${s.id}. [${s.start.toFixed(1)}–${s.end.toFixed(1)}] ${s.text}`),
      `\n## The creator's request\n${text}`,
    ]
      .filter(Boolean)
      .join("\n"),
  });
  const line = (id) => lines.find((s) => s.id === Number(id));
  const range = (o) => {
    let start = Number.isFinite(Number(o.from_time)) && o.from_time !== null && o.from_time !== "" ? Number(o.from_time) : line(o.from) ? line(o.from).start - 0.15 : null;
    let end = Number.isFinite(Number(o.to_time)) && o.to_time !== null && o.to_time !== "" ? Number(o.to_time) : line(o.to) ? line(o.to).end + 0.3 : null;
    if (start !== null) start = +Math.max(0, Math.min(duration, start)).toFixed(2);
    if (end !== null) end = +Math.max(0, Math.min(duration, end)).toFixed(2);
    return { start, end };
  };
  const text70 = (v) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
  const add = (Array.isArray(json.add) ? json.add : [])
    .map((o) => ({ ...range(o), title: text70(o.title), hook: text70(o.hook).slice(0, 40), reason: String(o.reason ?? ""), score: Math.max(0, Math.min(100, Number(o.score) || 0)) }))
    .filter((o) => o.start !== null && o.end !== null && o.end - o.start >= MIN && o.end - o.start <= MAX && o.title);
  const change = (Array.isArray(json.change) ? json.change : [])
    .map((o) => {
      const patch = { id: Number(o.id) };
      const r = range(o);
      if (r.start !== null) patch.start = r.start;
      if (r.end !== null) patch.end = r.end;
      if (typeof o.title === "string" && o.title.trim()) patch.title = text70(o.title);
      if (typeof o.hook === "string") patch.hook = text70(o.hook).slice(0, 40);
      if (FRAMES.includes(o.frame)) patch.frame = o.frame;
      if (typeof o.captions === "boolean") patch.captions = o.captions;
      if (Number.isFinite(Number(o.focus)) && o.focus !== null && o.focus !== "") patch.focus = Math.max(0, Math.min(1, Number(o.focus)));
      return patch;
    })
    .filter((p) => Number.isFinite(p.id) && Object.keys(p).length > 1);
  const remove = (Array.isArray(json.remove) ? json.remove : []).map(Number).filter(Number.isFinite);
  return { reply: String(json.reply ?? "").trim() || "Feito.", add, change, remove };
}

// --- Finding the moments on its own -------------------------------------------------------------------

const FIND_ROLE = `You are the Shorts agent of a gameplay creator who talks over the game (Brazilian Portuguese). Find the moments of this recording that work ALONE as a vertical Short (15 to 60 seconds) or a Story: a big play, a crash, a clutch, a fail, a funny or tense reaction, a payoff. They must make sense without the rest of the video, start right before the thing happens (no slow lead-in) and end on the payoff, never in the middle of a sentence or of the action.
Each transcript line has its time and how much happens on screen there, MEASURED on the picture and the game sound: [ação 0.9] is a lot, [ação 0.2] is calm. Lines starting with "~" are stretches without speech, with their measured action. A moment with strong action can be great even with no speech; a funny line can be great with calm picture.
Reply with JSON only: { "moments": [{ "start": 0.0, "end": 0.0, "title": "Short title in Brazilian Portuguese", "why": "" }] } with 6 to 10 moments, times in seconds.`;

const LOOK_ROLE = `You check candidate Shorts of a gameplay video by looking at frames. The image has one row per candidate, labelled with its number and times; each row shows 5 frames from its start to its end.
For each candidate: score it 0-100 as a Short (does something visibly happen? is it clear on a phone? does it start and end at good points?), adjust start/end by up to 8 seconds when the frames show it starts too early/late or cuts the action, write a hook for the top of the video (max 28 characters, CAPS, Brazilian Portuguese), say where the player's character is across the row ("subject": 0 = left edge of the frame, 0.5 = middle, 1 = right edge; in third-person games usually near the middle; when there is no character, the main action) and say which single one is the best Story to announce the new video.
Reply with JSON only: { "shorts": [{ "n": 1, "score": 0, "start": 0.0, "end": 0.0, "title": "", "hook": "", "subject": 0.5, "why": "short reason in Brazilian Portuguese" }], "story": 1 }`;

const LOCATE_ROLE = `You look at frames of gameplay clips that will become vertical Shorts, so the phone-sized crop must keep the player's character in view. The image has one row per clip, labelled with its number; each row shows 3 frames of it.
For each row say where the player's character is horizontally: 0 = left edge of the frame, 0.5 = middle, 1 = right edge (in third-person games usually near the middle; in a car, the car; when there is no character, the main action).
Reply with JSON only: { "clips": [{ "n": 1, "subject": 0.5 }] }`;

/**
 * Where the vertical crop goes so that `subject` (the character's horizontal place in the frame, 0–1) sits in the
 * middle of the phone screen: the "focus" the framing uses, for "fill" (full screen) or "square".
 */
function focusFor(subject, frame, width, height) {
  if (!Number.isFinite(subject) || !width || !height || height >= width) return 0.5;
  const a = width / height;
  const x = frame === "fill" ? (subject * (H * a) - W / 2) / (H * a - W) : (subject * a - 0.5) / (a - 1);
  return +Math.max(0, Math.min(1, x)).toFixed(3);
}

/** Rows of frames of each range, `per` frames a row and `rows` rows a sheet, labelled with their number. */
async function frameSheets(ctx, { source, folder, ranges, per, rows, fontFile }) {
  fs.rmSync(folder, { recursive: true, force: true });
  fs.mkdirSync(folder, { recursive: true });
  const sheets = [];
  for (let page = 0; page * rows < ranges.length; page++) {
    const group = ranges.slice(page * rows, page * rows + rows);
    let k = 0;
    for (const [r, c] of group.entries()) {
      for (let i = 0; i < per; i++) {
        const at = c.start + ((c.end - c.start) * (i + 0.5)) / per;
        const text = i === 0 ? `${page * rows + r + 1}  ${clock(c.start)}-${clock(c.end)}` : clock(at);
        const label = fontFile ? `,drawtext=fontfile='${fontFile.replace(":", "\\:")}':text='${text.replace(/:/g, "\\:")}':x=6:y=6:fontsize=20:fontcolor=yellow:box=1:boxcolor=black@0.7` : "";
        await ff(["-ss", at.toFixed(2), "-i", source, "-frames:v", "1", "-an", "-vf", withSdr(await sdrFilter(source), `scale=320:180${label}`), "-q:v", "4", path.join(folder, `q-${page}-${String(k++).padStart(3, "0")}.jpg`)], { signal: ctx.signal });
      }
    }
    const sheet = path.join(folder, `folha-${page + 1}.jpg`);
    await ff(["-framerate", "1", "-i", path.join(folder, `q-${page}-%03d.jpg`), "-vf", `tile=${per}x${group.length}`, "-frames:v", "1", "-q:v", "4", sheet], { signal: ctx.signal });
    sheets.push(sheet);
  }
  return sheets;
}

/** Where the character is in each moment that has no place yet (one look at 3 frames of each). id → subject. */
async function locate(ctx, { parent, parentDir, items, fontFile }) {
  const todo = items.filter((s) => !Number.isFinite(s.subject)).slice(0, 12);
  if (!todo.length) return new Map();
  const sheets = await frameSheets(ctx, { source: parent.source_path, folder: path.join(parentDir, "shorts-foco"), ranges: todo, per: 3, rows: 6, fontFile });
  const { json } = await ctx.llm.ask({ role: LOCATE_ROLE, model: ctx.settings.models.shorts ?? null, tools: ["Read"], signal: ctx.signal, prompt: `Open these images with the Read tool: ${sheets.join(", ")}.\n\n${todo.map((s, i) => `${i + 1}. ${s.title}`).join("\n")}` });
  const out = new Map();
  for (const c of Array.isArray(json.clips) ? json.clips : []) {
    const item = todo[Number(c?.n) - 1];
    const v = Number(c?.subject);
    if (item && Number.isFinite(v)) out.set(item.id, Math.max(0, Math.min(1, v)));
  }
  return out;
}

/**
 * Finds Short moments of a recording without being asked: the transcript with the action measured on the picture
 * and the game sound picks candidates, then a row of frames of each one is looked at to score them and fix where
 * they start and end. Returns moments ready to be added to the recording's list.
 */
async function discover(ctx, { parent, parentDir, visual, fontFile }) {
  const duration = parent.data.duration;
  const words = readWords(parentDir);
  const lines = sentences(words);
  const level = (a, b) => visual?.score?.length ? +(visual.score.slice(Math.max(0, Math.floor(a)), Math.max(Math.floor(a) + 1, Math.ceil(b))).reduce((s, v, _, all) => s + v / all.length, 0)).toFixed(1) : null;
  // Silent stretches with action are listed too: a play nobody comments on can still be the best Short.
  const quiet = [];
  let last = 0;
  for (const s of [...lines, { start: duration, end: duration }]) {
    if (s.start - last >= 6) quiet.push({ start: last, end: s.start });
    last = Math.max(last, s.end);
  }
  const rows = [
    ...lines.map((s) => ({ t: s.start, text: `[${clock(s.start)} ${s.start.toFixed(0)}s]${level(s.start, s.end) !== null ? ` [ação ${level(s.start, s.end)}]` : ""} ${s.text.slice(0, 90)}` })),
    ...quiet.map((q) => ({ t: q.start, text: `~ ${clock(q.start)}–${clock(q.end)} (${q.start.toFixed(0)}–${q.end.toFixed(0)} s) sem fala${level(q.start, q.end) !== null ? `, ação ${level(q.start, q.end)}` : ""}` })),
  ].sort((a, b) => a.t - b.t);
  if (!rows.length) throw new Error("Este vídeo não tem transcrição nem medição da imagem para achar Shorts.");
  ctx.log("info", `Agente de Shorts: procurando momentos em ${clock(duration)} de gravação (fala e ação na tela).`);
  const first = await ctx.llm.ask({
    role: FIND_ROLE,
    model: ctx.settings.models.shorts ?? null,
    signal: ctx.signal,
    prompt: [`Recording: "${parent.title}", ${clock(duration)}`, ctx.settings.channel?.niche ? `Channel: ${ctx.settings.channel.niche}` : "", "", ...rows.map((r) => r.text)].filter(Boolean).join("\n"),
  });
  const candidates = (Array.isArray(first.json.moments) ? first.json.moments : [])
    .map((m) => ({ start: Math.max(0, Number(m.start)), end: Math.min(duration, Number(m.end)), title: String(m.title ?? "").slice(0, 100), why: String(m.why ?? "") }))
    .filter((m) => Number.isFinite(m.start) && Number.isFinite(m.end) && m.end - m.start >= MIN && m.end - m.start <= MAX && m.title)
    .slice(0, 10);
  if (!candidates.length) return { moments: [], story: null };
  // Five frames of each candidate, one row each, in sheets of five rows.
  const sheets = await frameSheets(ctx, { source: parent.source_path, folder: path.join(parentDir, "shorts-quadros"), ranges: candidates, per: 5, rows: 5, fontFile });
  const second = await ctx.llm.ask({
    role: LOOK_ROLE,
    model: ctx.settings.models.shorts ?? null,
    tools: ["Read"],
    signal: ctx.signal,
    prompt: [
      `Open these images with the Read tool: ${sheets.join(", ")}.`,
      "",
      ...candidates.map((c, i) => {
        const said = lines.filter((s) => s.end > c.start && s.start < c.end).map((s) => s.text).join(" ").slice(0, 400);
        return `${i + 1}. ${c.start.toFixed(1)}–${c.end.toFixed(1)} s "${c.title}": ${c.why}${said ? `\n   said: "${said}"` : "\n   (no speech)"}`;
      }),
    ].join("\n"),
  });
  const moments = [];
  for (const item of Array.isArray(second.json.shorts) ? second.json.shorts : []) {
    const c = candidates[Number(item?.n) - 1];
    if (!c) continue;
    const near = (v, base) => (Number.isFinite(Number(v)) && v !== null && Math.abs(Number(v) - base) <= 8 ? Number(v) : base);
    const start = Math.max(0, near(item.start, c.start));
    const end = Math.min(duration, near(item.end, c.end));
    if (end - start < MIN || end - start > MAX) continue;
    moments.push({
      n: Number(item.n),
      start: +start.toFixed(2),
      end: +end.toFixed(2),
      title: String(item.title || c.title).slice(0, 100),
      hook: String(item.hook ?? "").toUpperCase().slice(0, 40),
      reason: `${c.why}${item.why ? ` Nos quadros: ${item.why}` : ""}`.trim(),
      score: Math.max(0, Math.min(100, Math.round(Number(item.score) || 0))),
      ...(Number.isFinite(Number(item.subject)) && item.subject !== null ? { subject: Math.max(0, Math.min(1, Number(item.subject))) } : {}),
    });
  }
  const story = moments.find((m) => m.n === Number(second.json.story)) ?? [...moments].sort((a, b) => b.score - a.score)[0] ?? null;
  ctx.log("decision", `Agente de Shorts: ${moments.length} momentos achados olhando fala, ação e quadros (${moments.map((m) => `${clock(m.start)} "${m.title}" ${m.score}`).join("; ")}).`);
  return { moments: moments.map(({ n, ...m }) => m), story: story ? (({ n, ...m }) => m)(story) : null };
}

/** Caption lines of a Short in its own times, two or three words each, as the render shows them. */
function captionLines(words, parts) {
  const toShort = mapper(parts);
  const said = words
    .map((w) => ({ text: String(w.text ?? "").trim(), start: toShort(w.start), end: toShort(Math.min(w.end, w.start + 1.5)) }))
    .filter((w) => /[\p{L}\p{N}]/u.test(w.text) && w.start !== null)
    .map((w) => ({ ...w, end: w.end ?? w.start + 0.3 }));
  const groups = [];
  for (const w of said) {
    const last = groups[groups.length - 1];
    const length = last ? last.reduce((n, x) => n + x.text.length + 1, 0) : 0;
    if (!last || last.length >= 3 || length + w.text.length > 16 || w.start - last[last.length - 1].end > 0.6 || /[.!?]$/.test(last[last.length - 1].text)) groups.push([w]);
    else last.push(w);
  }
  return groups.map((g, i) => ({ start: +g[0].start.toFixed(3), end: +Math.min(g[g.length - 1].end + 0.35, groups[i + 1]?.[0].start ?? Infinity).toFixed(3), text: g.map((x) => x.text).join(" ").toUpperCase() }));
}

/** Fractions of the source cut from the left and right so the framing shows what the render shows. */
function cropFor(frame, focus, width, height) {
  if (!width || !height || height >= width || frame === "fit") return { left: 0, right: 0, top: 0, bottom: 0 };
  const share = frame === "fill" ? (W / H) * (height / width) : height / width;
  const left = Math.max(0, Math.min(1, Number.isFinite(focus) ? focus : 0.5)) * (1 - share);
  return { left: +left.toFixed(4), right: +Math.max(0, 1 - share - left).toFixed(4), top: 0, bottom: 0 };
}

module.exports = { render, ask, discover, locate, focusFor, captionLines, cropFor, layout, segments, FRAMES, MIN, MAX };

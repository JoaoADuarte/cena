/**
 * Cut agent: word-by-word transcript, then what to take out (pauses, hesitations, stutters, dead
 * stretches, bad takes) and which moments would make good Shorts.
 * Rules handle what is measurable; the language model only judges meaning (a take said twice, a
 * mistake, rambling). Every cut carries its reason and can be switched off in the review.
 */
const fs = require("node:fs");
const path = require("node:path");
const { ff } = require("../ffmpeg.cjs");
const visualCheck = require("../visual.cjs");

const FONT = ["C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/arial.ttf"].find((f) => fs.existsSync(f)) ?? null;

const PAD = 0.13; // seconds of air left on each side of a cut
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const norm = (w) => w.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]/gu, "");

/** Said twice on purpose often enough that a repeat is not a stutter. */
const EMPHATIC = new Set(["muito", "bem", "nao", "sim", "vai", "tao", "mais", "nunca", "olha", "calma", "ai", "nossa", "ha", "ha", "kk", "tchau", "pera", "vem", "bora"]);
/** Elongated hesitation sounds. A plain "é" is a word and stays. */
const FILLER = /^(e{2,}|e+h+|a+h+n*|a{2,}|ha+n+|hu+m+|hm+|u+h+|a+n+h*|hum)$/;

/** Stretches below the noise floor, from FFmpeg's own detector. */
async function silences(file, signal) {
  const volume = await ff(["-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"], { signal });
  const mean = Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(volume)?.[1] ?? -30);
  const floor = Math.max(-55, Math.min(-30, mean - 16));
  const log = await ff(["-i", file, "-vn", "-af", `silencedetect=noise=${floor}dB:d=0.35`, "-f", "null", "-"], { signal });
  const found = [];
  let start = null;
  for (const line of log.split(/\r?\n/)) {
    const a = /silence_start:\s*(-?[\d.]+)/.exec(line);
    const b = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (a) start = Math.max(0, Number(a[1]));
    if (b && start !== null) {
      found.push({ start, end: Number(b[1]) });
      start = null;
    }
  }
  return { ranges: found, floor, mean };
}

/** Stretches where the picture does not move, read from key frames only so an hour takes seconds. */
async function frozen(file, signal) {
  try {
    const log = await ff(["-skip_frame", "nokey", "-i", file, "-an", "-vf", "scale=320:-2,freezedetect=n=0.003:d=5", "-f", "null", "-"], { signal });
    const found = [];
    let start = null;
    for (const line of log.split(/\r?\n/)) {
      const a = /freeze_start:\s*([\d.]+)/.exec(line);
      const b = /freeze_end:\s*([\d.]+)/.exec(line);
      if (a) start = Number(a[1]);
      if (b && start !== null) {
        found.push({ start, end: Number(b[1]) });
        start = null;
      }
    }
    return found;
  } catch (err) {
    if (signal?.aborted) throw err;
    return [];
  }
}

const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
const silentShare = (range, quiet) => quiet.reduce((sum, q) => sum + overlap(range, q), 0) / Math.max(0.001, range.end - range.start);

/** Sentences for the language model: split at punctuation or at a clear pause. */
function sentences(words) {
  const out = [];
  let current = null;
  words.forEach((w, i) => {
    const gap = i > 0 ? w.start - words[i - 1].end : 0;
    if (!current || gap > 1.2 || current.words.length >= 40) {
      current = { id: out.length + 1, start: w.start, end: w.end, words: [] };
      out.push(current);
    }
    current.words.push(w);
    current.end = w.end;
    if (/[.!?…]$/.test(w.text)) current = null;
  });
  return out.map((s) => ({ id: s.id, start: s.start, end: s.end, text: s.words.map((w) => w.text).join(" ") }));
}

const ROLE = `You are the Cut agent. You receive the transcript of a raw recording, one numbered sentence per line with its start time, and decide what should be cut for meaning. Pauses, silences and stutters are already handled by rules: do not report them.

1. "remove": stretches to take out. Only when you are confident:
   - "take_repetido": the creator says the same thing again in a better take. Remove the EARLIER, worse attempts and keep the last good one.
   - "erro": false starts, "não, pera", "deixa eu falar de novo", talking to someone off camera, checking notes, technical trouble.
   - "enrolacao": rambling that repeats what was already said and adds nothing.
   Be conservative. Jokes, reactions and personality are the video; never cut them. When unsure, leave it in.
   - "parado": a stretch where nothing happens on screen and nothing worth hearing is said (menu, loading, waiting, results screen). Use "from_time"/"to_time" in seconds for stretches given by a "~" line.
   Lines starting with "~" are measured from the picture and the game sound, not said by anyone: "ação" is strong movement on screen and loud game sound; "tela parada" is a still picture. A sentence ending in [ação] is said over strong action. Never remove action for being silent: in gameplay, action without talking is part of the video. Only cut action when the creator's instructions ask for it.
2. "shorts": 3 to 6 moments that would work alone as a vertical Short of 15 to 60 seconds: they start with a strong line, make sense without context and end on a payoff. Give each a score from 0 to 100.
3. "summary": two sentences about what the video is.
4. "missing_from_script": only when an approved script is given, the important parts of it that were never said in the recording (short descriptions). Otherwise an empty list.
5. "Creator's instructions" may be given: what the creator asked for this video before the work started. Follow the parts about what to cut or keep, even when that removes a lot, with kind "pedido" and a "reason" in Brazilian Portuguese that names the instruction. A stretch given by clock time ("corta do minuto 10 ao 25") uses "from_time" and "to_time", in seconds, instead of sentence numbers; report it only in the part of the recording where it falls. When they ask for a target length, remove the weakest stretches (kind "pedido") until what stays is near it. Stretches they want untouched go in "keep" (same fields): nothing will be removed there. Instructions about anything else (captions, music, title) are for other agents: ignore them.

Reply with:
{ "remove": [{ "from": 12, "to": 14, "kind": "take_repetido", "reason": "" }], "keep": [], "shorts": [{ "from": 40, "to": 47, "title": "", "reason": "", "score": 0 }], "summary": "", "missing_from_script": [] }
"from" and "to" are sentence numbers, inclusive.`;

const VOICE_ROLE = `You maintain the voice profile of one YouTube creator: a description of how they talk, used later to write scripts that sound like them.
From the current profile (may be empty) and a new transcript sample, write the updated profile in Brazilian Portuguese, at most 220 words: vocabulary and slang they really use, typical openings and closings, sentence length and rhythm, kind of humour, how they address the audience, verbal habits worth keeping and ones to avoid. Quote a few short real expressions. Describe only what the samples show.
Reply with: { "profile": "" }`;

async function judge(ctx, list, script) {
  const CHUNK = 700;
  const result = { remove: [], keep: [], shorts: [], summary: "", missing_from_script: [] };
  for (let at = 0; at < list.length; at += CHUNK) {
    const part = list.slice(at, at + CHUNK);
    const total = Math.ceil(list.length / CHUNK);
    const { json } = await ctx.llm.ask({
      role: ROLE,
      model: ctx.settings.models.cut,
      signal: ctx.signal,
      prompt: [
        total > 1 ? `Part ${at / CHUNK + 1} of ${total} of the recording.` : "The whole recording.",
        script ? `\n## Approved script\n${script}` : "",
        ctx.brief ? `\n## Creator's instructions\n${ctx.brief}` : "",
        "\n## Transcript",
        ...part.flatMap((s) => [...(s.before ?? []), `[${s.id}] ${clock(s.start)} ${s.text}${s.tag ?? ""}`]),
      ].join("\n"),
    });
    for (const key of ["remove", "keep", "shorts", "missing_from_script"]) if (Array.isArray(json[key])) result[key].push(...json[key]);
    if (json.summary && !result.summary) result.summary = String(json.summary);
    ctx.progress(0.6 + 0.3 * Math.min(1, (at + CHUNK) / list.length), "Avaliando os takes");
  }
  return result;
}

/**
 * Notes for the model about what the picture does: silent stretches with action or with a still screen between
 * sentences ("~" lines), and [ação] on sentences said over strong action.
 */
function describePicture(list, visual, duration) {
  const notes = [];
  for (const r of visual.action) notes.push({ start: r.start, end: r.end, text: "ação forte na tela e no som do jogo" });
  for (const r of visual.still) notes.push({ start: r.start, end: r.end, text: "tela parada (menu, carregamento, espera ou resultado?)" });
  notes.sort((a, b) => a.start - b.start);
  for (const n of notes) {
    // Placed before the first sentence that starts after it began; only the part nobody talks over matters here.
    const talking = list.filter((s) => s.start < n.end && s.end > n.start).reduce((sum, s) => sum + Math.min(n.end, s.end) - Math.max(n.start, s.start), 0);
    if (n.end - n.start - talking < 4) continue;
    const next = list.find((s) => s.start >= n.start) ?? list[list.length - 1];
    if (!next) continue;
    (next.before ??= []).push(`~ ${clock(n.start)}–${clock(Math.min(duration, n.end))} (${Math.round(n.start)}–${Math.round(n.end)} s): ${n.text}${talking > 1 ? ", com pouca fala" : ", sem fala"}`);
  }
  for (const s of list) if (visualCheck.actionShare(visual, s.start, s.end) >= 0.6) s.tag = " [ação]";
}

/** Strong action stretches and still screens, for the review panel. */
function actionSummary(visual) {
  // One value per 5 s: enough for a strip under the video, small enough to keep in the database.
  const strip = [];
  for (let s = 0; s < visual.score.length; s += 5) strip.push(+(visual.score.slice(s, s + 5).reduce((a, b) => a + b, 0) / Math.min(5, visual.score.length - s)).toFixed(2));
  return { every: 5, strip, action: visual.action, still: visual.still };
}

const LOOK_ROLE = `You check proposed cuts of a gameplay or talking video by looking at frames. The image has one row per proposed cut, labelled with its number and times; each row shows frames from the start to the end of the stretch that would be removed.
For each row decide: "cortar" if nothing worth keeping happens on screen (menus, loading, waiting, empty driving, a results screen nobody comments on), or "manter" if something happens (a crash, a fight, a chase, a funny or tense moment, a big play, a reaction worth seeing). When unsure, "manter".
Reply with: { "cuts": [{ "n": 1, "decision": "manter", "why": "short reason in Brazilian Portuguese" }] }`;

/**
 * The long cuts whose action level is in the middle (not clearly dead, not clearly action) get a row of frames
 * each; the model says which hide something worth keeping. At most 18 cuts, in sheets of 6.
 */
async function lookAtCuts(ctx, cuts, visual, source) {
  const doubtful = cuts
    .filter((c) => c.enabled && c.end - c.start >= 8 && !c.explicit)
    .map((c) => ({ c, level: visualCheck.actionIn(visual, c.start, c.end) }))
    .filter(({ level }) => level >= 0.35 && level < 0.7)
    .sort((a, b) => b.c.end - b.c.start - (a.c.end - a.c.start))
    .slice(0, 18)
    .map(({ c }) => c);
  if (!doubtful.length) return;
  const folder = path.join(ctx.workspace, `cortes-${ctx.video.id}`);
  fs.rmSync(folder, { recursive: true, force: true });
  fs.mkdirSync(folder, { recursive: true });
  const FRAMES = 4;
  const sheets = [];
  for (let page = 0; page * 6 < doubtful.length; page++) {
    const rows = doubtful.slice(page * 6, page * 6 + 6);
    let k = 0;
    for (const [r, c] of rows.entries()) {
      for (let i = 0; i < FRAMES; i++) {
        const at = c.start + ((c.end - c.start) * (i + 0.5)) / FRAMES;
        const text = i === 0 ? `${page * 6 + r + 1}  ${clock(c.start)}-${clock(c.end)}` : clock(at);
        const label = FONT ? `,drawtext=fontfile='${FONT.replace(":", "\\:")}':text='${text.replace(/:/g, "\\:")}':x=6:y=6:fontsize=20:fontcolor=yellow:box=1:boxcolor=black@0.7` : "";
        await ff(["-ss", at.toFixed(2), "-i", source, "-frames:v", "1", "-an", "-vf", `scale=320:180${label}`, "-q:v", "4", path.join(folder, `q-${page}-${String(k++).padStart(3, "0")}.jpg`)], { signal: ctx.signal });
      }
    }
    const sheet = path.join(folder, `folha-${page + 1}.jpg`);
    await ff(["-framerate", "1", "-i", path.join(folder, `q-${page}-%03d.jpg`), "-vf", `tile=${FRAMES}x${rows.length}`, "-frames:v", "1", "-q:v", "4", sheet], { signal: ctx.signal });
    sheets.push(path.basename(folder) + "/" + path.basename(sheet));
  }
  ctx.progress(0.92, "Conferindo os quadros dos cortes");
  const { json } = await ctx.llm.ask({
    role: LOOK_ROLE,
    model: ctx.settings.models.cut,
    tools: ["Read"],
    signal: ctx.signal,
    prompt: [`Open these images with the Read tool: ${sheets.join(", ")}.`, "", ...doubtful.map((c, i) => `${i + 1}. ${clock(c.start)}-${clock(c.end)}: ${c.kind}, ${c.reason}`)].join("\n"),
  });
  let kept = 0;
  for (const item of Array.isArray(json.cuts) ? json.cuts : []) {
    const c = doubtful[Number(item?.n) - 1];
    if (!c || item.decision !== "manter") continue;
    Object.assign(c, { enabled: false, reason: `${c.reason} (mantido: nos quadros, ${String(item.why ?? "acontece algo").slice(0, 120)})` });
    kept++;
  }
  ctx.log("decision", `Conferi os quadros de ${doubtful.length} cortes longos: ${kept} ficaram desligados porque acontece algo na tela.`);
}

/** Sorted, non-overlapping, and never leaving a sliver of video between two cuts. */
function tidy(cuts, duration) {
  const sorted = cuts
    .map((c) => ({ ...c, start: Math.max(0, c.start), end: Math.min(duration, c.end) }))
    .filter((c) => c.end - c.start >= 0.25)
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const cut of sorted) {
    const last = out[out.length - 1];
    if (last && last.enabled === cut.enabled && cut.start - last.end < 0.35) {
      last.end = Math.max(last.end, cut.end);
      if (!last.reason.includes(cut.reason)) last.reason = `${last.reason} + ${cut.reason}`;
    } else if (last && cut.start < last.end) {
      // Overlapping but one is only a suggestion: the certain one keeps its range.
      if (cut.end > last.end) out.push({ ...cut, start: last.end });
    } else out.push({ ...cut });
  }
  return out.filter((c) => c.end - c.start >= 0.25).map((c, i) => ({ ...c, id: i + 1, start: +c.start.toFixed(3), end: +c.end.toFixed(3) }));
}

/**
 * Over music or noise the transcription sometimes gets stuck and writes one phrase again and again.
 * The first time stays; the repeats that follow it are removed, in place. Returns how many words went.
 */
function dropLoops(words) {
  const text = words.map((w) => norm(String(w.text)));
  const drop = new Set();
  for (let i = 0; i < words.length; ) {
    let jump = 1;
    for (let n = 3; n <= 14 && i + 3 * n <= words.length; n++) {
      const same = (at) => { for (let k = 0; k < n; k++) if (text[i + k] !== text[at + k]) return false; return true; };
      if (!same(i + n) || !same(i + 2 * n)) continue;
      let end = i + n;
      while (end + n <= words.length && same(end)) end += n;
      for (let k = i + n; k < end; k++) drop.add(k);
      jump = end - i;
      break;
    }
    i += jump;
  }
  if (!drop.size) return 0;
  const keep = words.filter((_, k) => !drop.has(k));
  words.length = 0;
  words.push(...keep);
  return drop.size;
}

async function run(ctx) {
  const { video, dir, settings } = ctx;
  const { audioPath, duration } = video.data;
  const cfg = settings.cut;

  // A transcript of this same sound is not made twice: redoing the cuts with another request takes seconds.
  const transcriptPath = path.join(dir, "transcricao.json");
  const stamp = fs.statSync(audioPath).mtimeMs;
  let kept = null;
  try {
    const saved = JSON.parse(fs.readFileSync(transcriptPath, "utf8"));
    const same = saved.audio === undefined ? fs.statSync(transcriptPath).mtimeMs > stamp : saved.audio === stamp && saved.quality === cfg.quality && saved.language === (cfg.language || null);
    if (Array.isArray(saved.words) && saved.words.length && same) kept = saved.words;
  } catch {
    // No transcript yet.
  }
  ctx.progress(0.01, "Transcrevendo");
  const started = Date.now();
  const { words, device } = kept ? { words: kept, device: "saved" } : await ctx.transcribe(
    { path: audioPath, duration, language: cfg.language || null, quality: cfg.quality, device: "auto" },
    (p) => {
      const raw = p.total ? (p.done ?? p.loaded ?? 0) / p.total : 0;
      const part = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
      // The model download and the transcription share the bar: download fills the first 10%, the work the rest.
      const share = p.stage === "download" ? 0.1 * part : 0.1 + 0.9 * part;
      ctx.progress(0.01 + 0.44 * share, p.stage === "download" ? "Baixando o modelo de transcrição" : "Transcrevendo");
    },
  );
  if (!kept) {
    const loops = dropLoops(words);
    if (loops) ctx.log("warn", `A transcrição repetiu a mesma frase várias vezes em trechos sem fala clara: ${loops} palavras repetidas foram descartadas.`);
  }
  if (!kept) fs.writeFileSync(transcriptPath, JSON.stringify({ words, audio: stamp, quality: cfg.quality, language: cfg.language || null }));
  const spoken = words.reduce((sum, w) => sum + (w.end - w.start), 0);
  const speechRatio = duration > 0 ? spoken / duration : 0;
  const took = (Date.now() - started) / 1000;
  ctx.log("info", kept ? `Transcrição: ${words.length} palavras, aproveitada da vez anterior.` : `Transcrição: ${words.length} palavras em ${Math.round(took)} s (${(duration / Math.max(1, took)).toFixed(1)}x o tempo real, ${device === "dml" ? "placa de vídeo" : "processador"}).`);

  // A track of game sound settles it: the voices on top of it (the creator and the chat) can talk most of the time.
  const hasGame = (video.data.tracks ?? []).some((t) => t.role === "jogo");
  const mode = cfg.style === "auto" ? (hasGame || speechRatio < 0.45 ? "gameplay" : "falado") : cfg.style;
  ctx.log(
    "decision",
    `Fala em ${Math.round(speechRatio * 100)}% do tempo${hasGame ? ", com uma faixa só de jogo" : ""}: tratando como ${mode === "falado" ? "vídeo falado (todas as pausas longas saem)" : "gameplay com comentário (trechos sem fala ficam; só saem os parados)"}.`,
  );

  // Only listening for the Metadata and the Thumbnail: silences, frozen picture and takes are cutting work.
  if (ctx.light) {
    ctx.log("info", "Só a transcrição: o agente de Corte não foi escolhido, então silêncios, imagem parada e takes não são medidos.");
    return { cuts: [], shorts: [], summary: "", missing: [], speechRatio: +speechRatio.toFixed(3), mode, words: words.length, voice: null, action: null };
  }
  ctx.progress(0.47, "Medindo silêncios");
  const quiet = await silences(audioPath, ctx.signal);
  ctx.progress(0.52, "Procurando trechos parados");
  // What the picture and the game sound do, second by second (measured here, no tokens). Kept with the transcript.
  ctx.progress(0.53, "Medindo a ação na tela");
  const gameTrack = (video.data.tracks ?? []).find((t) => t.role === "jogo");
  let visual = null;
  // Only listening for the other agents (nothing is cut): no need to watch.
  if (!ctx.light) try {
    visual = await visualCheck.analyse(video.source_path, duration, { dir, signal: ctx.signal, gameStream: gameTrack ? gameTrack.index : null, onProgress: (p) => ctx.progress(0.53 + 0.06 * p, "Medindo a ação na tela") });
    const actionTime = visual.action.reduce((sum, r) => sum + r.end - r.start, 0);
    const stillTime = visual.still.reduce((sum, r) => sum + r.end - r.start, 0);
    ctx.log("info", `Imagem analisada em ${Math.round(visual.took)} s: ${clock(actionTime)} de ação forte em ${visual.action.length} trechos, ${clock(stillTime)} de tela parada, ${visual.sceneCuts.length} trocas de cena.`);
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    ctx.log("warn", `Não consegui analisar a imagem (${err.message}). Os cortes seguem só pela fala e pelo som.`);
  }
  const still = !cfg.removeStill ? [] : visual ? visual.still : await frozen(video.source_path, ctx.signal);

  const cuts = [];
  const add = (start, end, kind, reason, enabled = true) => cuts.push({ start, end, kind, reason, enabled });

  // Gaps between words.
  const edges = [{ end: 0 }, ...words, { start: duration }];
  for (let i = 1; i < edges.length; i++) {
    const range = { start: edges[i - 1].end, end: edges[i].start };
    const gap = range.end - range.start;
    if (gap < cfg.minPause) continue;
    const inner = { start: range.start + PAD, end: range.end - PAD };
    if (inner.end - inner.start < 0.25) continue;
    const isSilent = silentShare(range, quiet.ranges) > 0.6;
    if (mode === "falado") {
      if (isSilent) add(inner.start, inner.end, "silêncio", `Silêncio de ${gap.toFixed(1)} s`);
      else if (gap <= 4) add(inner.start, inner.end, "hesitação", `${gap.toFixed(1)} s com som mas sem palavras (hesitação, "ééé" ou respiração)`);
      else add(inner.start, inner.end, "sem fala", `${gap.toFixed(1)} s sem fala, mas com som: confira antes de cortar`, false);
    } else if (still.some((f) => overlap(f, range) > Math.min(gap, 3))) {
      // Handled below, with the frozen picture's own range.
    } else if (gap >= cfg.longQuiet) {
      // Silent gameplay full of action is the video, not a gap.
      const action = visual ? visualCheck.actionIn(visual, range.start, range.end) : null;
      if (action === null || action < 0.55) add(inner.start, inner.end, "sem fala", `${Math.round(gap)} s de gameplay sem comentário${action === null ? "" : " e com pouca ação"}: sugestão, fica desligada até você ligar`, false);
    }
  }
  // Picture frozen and nobody talking: nothing is happening.
  for (const f of still) {
    const talking = words.some((w) => w.start < f.end - 0.5 && w.end > f.start + 0.5);
    if (!talking) add(f.start + 0.4, f.end - 0.4, "parado", `Imagem parada por ${Math.round(f.end - f.start)} s, sem fala`);
  }
  // Hesitation sounds and stutters that Whisper did write down.
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const key = norm(w.text);
    if (FILLER.test(key)) add(w.start - 0.03, w.end + 0.03, "hesitação", `"${w.text}"`);
    const next = words[i + 1];
    if (next && key && key === norm(next.text) && next.start - w.end < 0.9 && !EMPHATIC.has(key)) add(w.start - 0.03, next.start - 0.03, "gaguejo", `"${w.text}" repetido`);
  }
  const byRules = cuts.length;

  // Meaning: repeated takes, mistakes, rambling, and the best moments.
  ctx.progress(0.6, "Avaliando os takes");
  const list = sentences(words);
  if (visual) describePicture(list, visual, duration);
  let judged = { remove: [], keep: [], shorts: [], summary: "", missing_from_script: [] };
  // Not asked to cut (it only listens, for the other agents): the rules stay as suggestions and no tokens are spent.
  if (list.length >= 3 && ctx.llm.available() && !ctx.light) {
    try {
      judged = await judge(ctx, list, ctx.scriptText);
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.log("warn", `Não consegui avaliar os takes com IA (${err.message}). Seguindo só com as regras.`);
    }
  }
  const byId = new Map(list.map((s) => [s.id, s]));
  const span = (item) => {
    const timed = item.from_time !== null && item.from_time !== undefined && item.to_time !== null && item.to_time !== undefined;
    if (timed && Number(item.to_time) > Number(item.from_time)) return { start: Math.max(0, Number(item.from_time)), end: Math.min(duration, Number(item.to_time)) };
    const a = byId.get(Number(item.from));
    const b = byId.get(Number(item.to ?? item.from));
    return a && b && b.end > a.start ? { start: a.start, end: b.end } : null;
  };
  const KINDS = { take_repetido: "take repetido", erro: "erro", enrolacao: "enrolação", parado: "parado" };
  for (const item of judged.remove) {
    const range = span(item);
    if (!range) continue;
    // Never let one judgement remove a large part of the video without the creator looking.
    const big = range.end - range.start > Math.max(45, duration * 0.1);
    // What the creator asked for in so many words is not held back for being large.
    const asked = item.kind === "pedido" && Boolean(ctx.brief);
    add(range.start - 0.05, range.end + 0.05, asked ? "pedido" : (KINDS[item.kind] ?? "erro"), String(item.reason ?? ""), asked || !big);
    // A stretch the creator gave by clock time is theirs: the action check leaves it alone.
    if (asked && item.from_time !== undefined && item.from_time !== null) cuts[cuts.length - 1].explicit = true;
  }
  for (const item of judged.keep ?? []) {
    const range = ctx.brief ? span(item) : null;
    if (!range) continue;
    for (const c of cuts) if (c.enabled && c.kind !== "pedido" && overlap(c, range) > 0) Object.assign(c, { enabled: false, reason: `${c.reason} (mantido a seu pedido)` });
  }
  const shorts = judged.shorts
    .map((item) => ({ range: span(item), item }))
    .filter(({ range }) => range && range.end - range.start >= 8 && range.end - range.start <= 90)
    .map(({ range, item }, i) => ({ id: i + 1, start: +range.start.toFixed(2), end: +range.end.toFixed(2), title: String(item.title ?? ""), reason: String(item.reason ?? ""), score: Math.max(0, Math.min(100, Number(item.score) || 0)) }))
    .sort((a, b) => b.score - a.score);

  // Action stays: a cut that would take out strong action on screen is held back, whoever proposed it.
  if (visual) {
    let held = 0;
    for (const c of cuts) {
      if (!c.enabled || c.end - c.start < 1.5 || c.explicit) continue;
      const share = visualCheck.actionShare(visual, c.start, c.end);
      const level = visualCheck.actionIn(visual, c.start, c.end);
      if (share >= 0.5 || level >= 0.7) {
        Object.assign(c, { enabled: false, reason: `${c.reason} (mantido: tem ação na tela e no som do jogo)` });
        held++;
      }
    }
    if (held) ctx.log("decision", `${held} cortes ficaram desligados porque o trecho tem ação forte na tela. Você pode ligar qualquer um no painel de cortes.`);
    // The doubtful long cuts are looked at: a few frames of each, seen by the model.
    if (ctx.llm.available() && !ctx.light && ctx.workspace) {
      try {
        await lookAtCuts(ctx, cuts, visual, video.source_path);
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        ctx.log("warn", `Não consegui conferir os quadros dos cortes (${err.message}).`);
      }
    }
  }
  if (ctx.light) for (const c of cuts) c.enabled = false;
  const final = tidy(cuts, duration);
  const on = final.filter((c) => c.enabled);
  const removed = on.reduce((sum, c) => sum + c.end - c.start, 0);
  const count = (kind) => on.filter((c) => c.kind === kind).length;
  ctx.log(
    "decision",
    `${on.length} cortes ligados tiram ${clock(removed)} de ${clock(duration)} (${Math.round((removed / Math.max(1, duration)) * 100)}%): ` +
      ["silêncio", "hesitação", "gaguejo", "parado", "take repetido", "erro", "enrolação", "pedido"].map((k) => `${count(k)} ${k}`).filter((t) => !t.startsWith("0 ")).join(", ") +
      `. ${final.length - on.length} sugestões desligadas. ${byRules} vieram das regras, ${judged.remove.length} da avaliação dos takes.`,
  );
  if (shorts.length) ctx.log("decision", `Sugestões de Shorts: ${shorts.map((s) => `${clock(s.start)}–${clock(s.end)} "${s.title}" (${s.score})`).join("; ")}.`);
  const missing = (judged.missing_from_script ?? []).map(String).filter(Boolean);
  if (missing.length) ctx.log("warn", `Partes do roteiro que não apareceram na gravação: ${missing.join("; ")}.`);

  // What this recording teaches about how the creator talks.
  let voice = null;
  if (settings.voice.learn && words.length > 250 && ctx.llm.available() && !ctx.light) {
    try {
      const sample = words.slice(0, 2600).map((w) => w.text).join(" ");
      const { json } = await ctx.llm.ask({ role: VOICE_ROLE, model: settings.models.cut, signal: ctx.signal, prompt: `## Current profile\n${ctx.voice.text || "(empty)"}\n\n## New transcript sample\n${sample}` });
      // Words per minute while talking: breaths between words count, long pauses do not.
      let talking = 0;
      words.forEach((w, i) => (talking += w.end - w.start + (i > 0 ? Math.min(0.8, Math.max(0, w.start - words[i - 1].end)) : 0)));
      const wpm = Math.round(words.length / Math.max(0.5, talking / 60));
      if (json.profile) voice = { text: String(json.profile), wpm: Math.max(110, Math.min(200, wpm)) };
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.log("warn", `Perfil de voz não atualizado: ${err.message}`);
    }
  }

  return { cuts: final.map(({ explicit, ...c }) => c), shorts, summary: judged.summary, missing, speechRatio: +speechRatio.toFixed(3), mode, words: words.length, voice, action: visual ? actionSummary(visual) : null };
}

module.exports = { run, tidy, sentences, clock };

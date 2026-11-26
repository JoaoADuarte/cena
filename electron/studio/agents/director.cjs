/**
 * Direction: what the creator wrote before the agents start ("vídeo de 20 minutos, sem música, legendas
 * grandes, corta as partes em que fico no menu") and what they ask about the cuts while the flow is stopped.
 * `interpret` turns the settings-like part of the request into this video's overrides; the same text is also
 * read by the Cut, Edit, Metadata and Thumbnail agents, each for its own job.
 * `cuts` turns a request about what to remove or keep into operations on the cut list.
 */
const fs = require("node:fs");
const path = require("node:path");
const { sentences, clock } = require("./cut.cjs");
const { mergedCuts } = require("./edit.cjs");

const EDIT_FLAGS = ["captions", "zooms", "texts", "transitions", "music", "colour", "broll", "stabilize"];
/** Stages after which the flow can wait for the creator: after the cuts, and right before the render. */
const STOPS = ["cut", "thumbnail"];

const ROLE = `You are the Director of a small video studio. Before the other agents start working on a raw recording, the creator wrote how they want this video edited. Translate what is in the request into settings. Other agents read the same request later for the content decisions (what to cut, where to zoom, the title): do not try to do their work.

Fields, all optional. Send only what the request really asks for:
- "edit": { "captions", "zooms", "texts", "transitions", "music", "colour", "broll", "stabilize": true | false,
            "captionWords": 1-8 (words per caption), "musicVolume": 0.02-0.5 (0.12 is the usual), "musicQuery": "english search for the kind of music",
            "intensity": "leve" | "media" | "intensa", "textColour": "#rrggbb" }
- "audio": { "preset": "voz" | "misto" | "leve", "noise": 0-30,
             "gameLevel": -30 to 0   (how many dB the game sound sits under the voices; -10 is the usual, -18 is a quiet game, -4 a loud one),
             "chatLevel": -30 to 6   (the same for the voice chat, Discord; -2 is the usual) }
- "cut": { "style": "falado" | "gameplay"   (falado: every long pause comes out; gameplay: stretches without talk stay),
           "minPause": 0.3-3   (seconds of pause that is cut; lower = tighter pacing),
           "removeStill": true | false   (remove stretches where the picture is frozen and nobody talks) }
- "split": { "count": 4 or null, "rule": "each video has two races" }   only when the creator wants this ONE recording turned into SEVERAL videos. "rule" says, in English, what goes in each video. Leave it out otherwise.
- "stops": ["cut"] and/or ["render"]   only when the creator asks to check the cuts before going on ("cut") or to be asked before the final render ("render")
- "notes": one or two sentences in Brazilian Portuguese telling the creator how you understood the request, including the parts that the other agents will handle (cuts by content, target length, title)

Reply with: { "edit": {}, "audio": {}, "cut": {}, "split": null, "stops": [], "notes": "" }`;

const num = (value, lo, hi) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Math.max(lo, Math.min(hi, Number(value))));

async function interpret(ctx, video, text) {
  const { json } = await ctx.llm.ask({
    role: ROLE,
    model: ctx.settings.models.edit,
    signal: ctx.signal,
    prompt: [`Recording: "${video.title}"${video.data.duration ? `, ${clock(video.data.duration)} long` : ""}.`, ctx.settings.channel.niche ? `Channel: ${ctx.settings.channel.niche}` : "", `\nCreator's request:\n${text}`].filter(Boolean).join("\n"),
  });
  const overrides = { edit: {}, audio: {}, cut: {} };
  const e = json.edit ?? {};
  for (const flag of EDIT_FLAGS) if (typeof e[flag] === "boolean") overrides.edit[flag] = e[flag];
  if (num(e.captionWords, 1, 8) !== null) overrides.edit.captionWords = Math.round(num(e.captionWords, 1, 8));
  if (num(e.musicVolume, 0.02, 0.5) !== null) overrides.edit.musicVolume = num(e.musicVolume, 0.02, 0.5);
  if (typeof e.musicQuery === "string" && e.musicQuery.trim()) overrides.edit.musicQuery = e.musicQuery.trim().slice(0, 80);
  if (["leve", "media", "intensa"].includes(e.intensity)) overrides.edit.intensity = e.intensity;
  if (/^#[0-9a-f]{6}$/i.test(String(e.textColour ?? ""))) overrides.edit.textColour = e.textColour;
  const a = json.audio ?? {};
  if (["voz", "misto", "leve"].includes(a.preset)) overrides.audio.preset = a.preset;
  if (num(a.noise, 0, 30) !== null) overrides.audio.noise = num(a.noise, 0, 30);
  if (num(a.gameLevel, -30, 0) !== null) overrides.audio.gameLevel = num(a.gameLevel, -30, 0);
  if (num(a.chatLevel, -30, 6) !== null) overrides.audio.chatLevel = num(a.chatLevel, -30, 6);
  const c = json.cut ?? {};
  if (["falado", "gameplay"].includes(c.style)) overrides.cut.style = c.style;
  if (num(c.minPause, 0.3, 3) !== null) overrides.cut.minPause = num(c.minPause, 0.3, 3);
  if (typeof c.removeStill === "boolean") overrides.cut.removeStill = c.removeStill;
  const s = json.split && typeof json.split === "object" ? json.split : null;
  const split = s && (num(s.count, 2, 20) !== null || String(s.rule ?? "").trim()) ? { count: num(s.count, 2, 20) === null ? null : Math.round(num(s.count, 2, 20)), rule: String(s.rule ?? "").trim().slice(0, 300) } : null;
  const stops = (Array.isArray(json.stops) ? json.stops : []).map((s) => (s === "render" ? "thumbnail" : s)).filter((s) => STOPS.includes(s));
  const said = [
    ...Object.entries(overrides.edit).map(([k, v]) => `${k}: ${v}`),
    ...Object.entries(overrides.audio).map(([k, v]) => `som ${k}: ${v}`),
    ...Object.entries(overrides.cut).map(([k, v]) => `corte ${k}: ${v}`),
    ...stops.map((s) => (s === "cut" ? "parar depois do Corte" : "parar antes da Montagem")),
    ...(split ? [`dividir em ${split.count ?? "vários"} vídeos${split.rule ? ` (${split.rule})` : ""}`] : []),
  ];
  return { overrides, stops, split, notes: String(json.notes ?? "").trim(), said };
}

// --- Requests about the cuts ---------------------------------------------------------------------------
const KINDS = ["silêncio", "hesitação", "gaguejo", "parado", "sem fala", "take repetido", "erro", "enrolação", "pedido", "manual"];

const CUTS_ROLE = `You are the Cut agent. The flow of the studio is stopped so the creator can decide what stays in the video, and they wrote a request about the cuts. Translate it into operations on the cut list.

You receive the transcript of the ORIGINAL recording (one numbered sentence per line with its clock time), a summary of the cut list, and its larger cuts. A cut that is ON removes that stretch; one that is off is only a suggestion. You do not see the picture, but you get what was measured on it: stretches of strong action (movement on screen and loud game sound) and of still picture (menus, loading, waiting, results). Use them for requests like "tira os menus" or "só os momentos de ação".

Operations:
- { "op": "add", "from": 12, "to": 18, "reason": "" }   remove sentences 12 to 18, inclusive
- { "op": "add_time", "start": 600, "end": 1500, "reason": "" }   remove a stretch given by time, in seconds of the original recording
- { "op": "keep_time", "start": 0, "end": 95 }   nothing may be removed in that stretch: every cut inside it is switched off
- { "op": "enable", "id": 7 } / { "op": "disable", "id": 7 }   one cut of the list
- { "op": "enable_kind", "kind": "sem fala" } / { "op": "disable_kind", "kind": "silêncio" }   every cut of one kind (${KINDS.join(", ")})

When the creator gives a time ("do minuto 10 ao 25", "1:02:30") it is a time of the original recording. "Deixa só do X ao Y" means removing everything before X and after Y.
When they ask for a target length, remove the least interesting stretches (rambling, waiting, repeated attempts, long stretches where nothing is said and nothing happens on screen) until what is kept is near it, and keep the strongest moments. Stretches of strong action are strong moments even when nobody talks: do not remove them for a target length. Say in the reply how long the video should end up.
"reason" is a short note in Brazilian Portuguese that the creator will read in the list.
Do only what was asked. Reply with: { "operations": [], "reply": "one or two sentences in Brazilian Portuguese saying what changes" }`;

function readWords(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "transcricao.json"), "utf8")).words ?? [];
  } catch {
    return [];
  }
}

const removed = (cuts) => mergedCuts(cuts).reduce((sum, c) => sum + c.end - c.start, 0);

async function cuts(ctx, { video, dir, text }) {
  const duration = video.data.duration;
  const lines = sentences(readWords(dir));
  const list = video.data.cuts ?? [];
  const byKind = new Map();
  for (const c of list) {
    const entry = byKind.get(c.kind) ?? { on: 0, off: 0, seconds: 0 };
    if (c.enabled) {
      entry.on++;
      entry.seconds += c.end - c.start;
    } else entry.off++;
    byKind.set(c.kind, entry);
  }
  const large = list.filter((c) => c.end - c.start >= 4 || !["silêncio", "hesitação", "gaguejo"].includes(c.kind)).slice(0, 220);
  // Very long recordings: every line is kept, each one shortened, so the request still sees the whole video.
  const width = lines.length > 2200 ? 70 : lines.length > 1200 ? 110 : 200;
  const { json } = await ctx.llm.ask({
    role: CUTS_ROLE,
    model: ctx.settings.models.cut,
    signal: ctx.signal,
    prompt: [
      `Creator's request: ${text}`,
      `\nRecording: "${video.title}", ${clock(duration)} long (${Math.round(duration)} s). With the cuts that are ON now the video has ${clock(duration - removed(list))}.`,
      video.data.summary ? `Summary: ${video.data.summary}` : "",
      "\n## Cut list by kind",
      ...[...byKind.entries()].map(([kind, n]) => `${kind}: ${n.on} ON (${clock(n.seconds)} removed), ${n.off} off`),
      "\n## Larger cuts",
      ...large.map((c) => `#${c.id} ${c.enabled ? "ON " : "off"} ${clock(c.start)}–${clock(c.end)} (${c.start.toFixed(1)}–${c.end.toFixed(1)} s) · ${c.kind}: ${String(c.reason).slice(0, 90)}`),
      ...(video.data.action
        ? [
            "\n## Measured on the picture",
            `Strong action: ${video.data.action.action.map((r) => `${clock(r.start)}–${clock(r.end)} (${r.start}–${r.end} s)`).join(", ") || "none"}`,
            `Still picture: ${video.data.action.still.map((r) => `${clock(r.start)}–${clock(r.end)} (${r.start}–${r.end} s)`).join(", ") || "none"}`,
          ]
        : []),
      "\n## Transcript",
      ...lines.map((s) => `[${s.id}] ${clock(s.start)} ${s.text.slice(0, width)}`),
    ]
      .filter(Boolean)
      .join("\n"),
  });

  const byId = new Map(lines.map((s) => [s.id, s]));
  let next = list.map((c) => ({ ...c }));
  const applied = [];
  const add = (start, end, reason) => {
    const from = Math.max(0, Number(start));
    const to = Math.min(duration, Number(end));
    if (!(to - from >= 0.25)) return;
    next.push({ id: 0, start: +from.toFixed(3), end: +to.toFixed(3), kind: "pedido", reason: String(reason || "Pedido por você").slice(0, 160), enabled: true });
    applied.push(`Corte de ${clock(from)} a ${clock(to)}`);
  };
  for (const op of Array.isArray(json.operations) ? json.operations : []) {
    const target = next.find((c) => c.id === Number(op.id) && c.id > 0);
    if (op.op === "add") {
      const a = byId.get(Number(op.from));
      const b = byId.get(Number(op.to ?? op.from));
      if (a && b && b.end > a.start) add(a.start - 0.05, b.end + 0.05, op.reason);
    } else if (op.op === "add_time") add(op.start, op.end, op.reason);
    else if (op.op === "keep_time" && Number(op.end) > Number(op.start)) {
      let count = 0;
      next = next.map((c) => {
        if (!c.enabled || c.end <= Number(op.start) || c.start >= Number(op.end)) return c;
        count++;
        return { ...c, enabled: false };
      });
      applied.push(`${count} cortes desligados entre ${clock(Number(op.start))} e ${clock(Number(op.end))}`);
    } else if ((op.op === "enable" || op.op === "disable") && target) {
      target.enabled = op.op === "enable";
      applied.push(`Corte #${target.id} (${clock(target.start)}) ${target.enabled ? "ligado" : "desligado"}`);
    } else if ((op.op === "enable_kind" || op.op === "disable_kind") && KINDS.includes(op.kind)) {
      const on = op.op === "enable_kind";
      const count = next.filter((c) => c.kind === op.kind && c.enabled !== on).length;
      next = next.map((c) => (c.kind === op.kind ? { ...c, enabled: on } : c));
      applied.push(`${count} cortes "${op.kind}" ${on ? "ligados" : "desligados"}`);
    }
  }
  const reply = String(json.reply ?? "").trim() || (applied.length ? applied.join(". ") : "Não encontrei o que mudar nos cortes.");
  return { cuts: next, reply, applied, changed: applied.length > 0 };
}

// --- One recording, several videos ------------------------------------------------------------------------
const SPLIT_ROLE = `You are the Director of a small video studio. The creator recorded one long session and wants it turned into several videos. Decide where each video starts and ends.

You can look at contact sheets: images in the working folder, each a grid of frames of the recording in time order, every frame labelled with its time (hh:mm:ss). Open them with the Read tool. Menus, loading screens, results and winner screens, lobbies and map changes usually mark where one game, race, round or topic ends and the next begins. You also get what was said, with times.

Rules:
- Times are seconds of the original recording. Parts are in order and do not overlap.
- Leave out what belongs to no video (long menus, loading, waiting between rounds) by starting a part after it.
- Follow the creator's request: how many videos and what goes in each. If the recording does not have enough material for what they asked, make as many as it really has and say so.
- "title" is a short working title in Brazilian Portuguese; "reason" says what is in the part (for example "corridas 3 e 4: aeroporto e túnel").
Reply with: { "parts": [ { "title": "", "start": 0, "end": 0, "reason": "" } ], "reply": "one or two sentences in Brazilian Portuguese for the creator" }`;

const FONT = ["C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/arial.ttf"].find((f) => fs.existsSync(f)) ?? null;

/** Grids of frames with their times: what lets an agent that only reads text see where the games or rounds change. */
async function contactSheets(source, duration, folder, { signal, ff }) {
  fs.rmSync(folder, { recursive: true, force: true });
  fs.mkdirSync(folder, { recursive: true });
  // At most about 270 frames (9 sheets of 30) whatever the length.
  const every = Math.max(5, Math.min(60, Math.ceil(duration / 270)));
  const label = FONT ? `,drawtext=fontfile='${FONT.replace(":", "\\:")}':text='%{pts\\:hms}':x=6:y=6:fontsize=22:fontcolor=yellow:box=1:boxcolor=black@0.7` : "";
  // Key frames only: seconds instead of minutes for a two-hour recording.
  await ff(["-skip_frame", "nokey", "-i", source, "-an", "-sn", "-vf", `fps=1/${every},scale=320:-2${label},tile=6x5`, "-fps_mode", "vfr", "-q:v", "4", path.join(folder, "folha-%02d.jpg")], { signal });
  return { every, files: fs.readdirSync(folder).filter((f) => f.endsWith(".jpg")).sort() };
}

/** Tidy parts: in order, inside the recording, not overlapping, none shorter than 20 s. */
function cleanParts(list, duration) {
  const out = [];
  const given = (Array.isArray(list) ? list : [])
    .map((p) => ({ title: String(p?.title ?? "").trim().slice(0, 120), reason: String(p?.reason ?? "").trim().slice(0, 300), start: Math.max(0, Number(p?.start)), end: Math.min(duration, Number(p?.end)) }))
    .filter((p) => Number.isFinite(p.start) && Number.isFinite(p.end))
    .sort((a, b) => a.start - b.start);
  for (const p of given) {
    const last = out[out.length - 1];
    if (last && p.start < last.end) p.start = last.end;
    if (p.end - p.start >= 20) out.push({ ...p, start: +p.start.toFixed(2), end: +p.end.toFixed(2) });
  }
  return out.map((p, i) => ({ ...p, id: i + 1, title: p.title || `Parte ${i + 1}` }));
}

/**
 * Where each of the videos asked for starts and ends. `want`: { count, rule } read from the request;
 * `text`: the request itself (or a new one about the parts). `workspace`: the folder the agents work in.
 */
async function splitParts(ctx, { video, dir, text, want, workspace, ff, previous = null }) {
  const duration = video.data.duration;
  const folder = path.join(workspace, `folhas-${video.id}`);
  ctx.progress?.(0.1, "Montando as folhas de quadros");
  const sheets = await contactSheets(video.source_path, duration, folder, { signal: ctx.signal, ff });
  const lines = sentences(readWords(dir));
  const width = lines.length > 2200 ? 60 : lines.length > 1200 ? 100 : 180;
  ctx.progress?.(0.4, "Procurando onde cada vídeo começa e termina");
  try {
    const { json } = await ctx.llm.ask({
      role: SPLIT_ROLE,
      model: ctx.settings.models.edit,
      tools: ["Read"],
      signal: ctx.signal,
      prompt: [
        `Creator's request: ${text}`,
        want ? `Read as: ${want.count ? `${want.count} videos` : "several videos"}${want.rule ? `, ${want.rule}` : ""}.` : "",
        `\nRecording: "${video.title}", ${clock(duration)} long (${Math.round(duration)} s).`,
        previous?.length ? `\nParts proposed before (the creator wants them changed):\n${previous.map((p) => `- ${p.title}: ${p.start}–${p.end} s`).join("\n")}` : "",
        `\n## Contact sheets (one frame every ${sheets.every} s, 30 per sheet, left to right and top to bottom)`,
        ...sheets.files.map((f) => `folhas-${video.id}/${f}`),
        "\n## What was said",
        ...(lines.length ? lines.map((s) => `${clock(s.start)} ${s.text.slice(0, width)}`) : ["(almost nothing)"]),
      ]
        .filter(Boolean)
        .join("\n"),
    });
    const parts = cleanParts(json.parts, duration);
    if (!parts.length) throw new Error("O agente não encontrou como dividir esta gravação.");
    return { parts, reply: String(json.reply ?? "").trim() };
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

module.exports = { interpret, cuts, removed, splitParts, cleanParts, STOPS };

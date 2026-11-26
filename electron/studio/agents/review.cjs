/**
 * Corrections agent: turns what the creator wrote in the review ("tira o corte em 2:13",
 * "deixa a voz mais limpa", "sem música", "troca o texto da thumbnail") into changes to the video's
 * cut list, sound settings, editing plan and thumbnail request.
 * It only edits that data; the stages that depend on it run again afterwards.
 */
const { clock } = require("./cut.cjs");
const { timeline, original } = require("./edit.cjs");

const ROLE = `You are the Corrections agent. The creator watched the finished video and wrote what to change. Translate the request into operations.

You receive the cut list (each cut has its time in the ORIGINAL recording and "final", the moment in the FINISHED video where that cut happens), the editing plan (zooms, texts on screen, transitions, each with its moment in the FINISHED video), the editing and sound settings, and the thumbnail texts.
When the creator gives a time, they are watching the finished video: match it against "final" first, and against the original times only if nothing is near.

Operations:
- { "op": "disable_cut", "id": 12 }  keep that stretch in the video after all
- { "op": "enable_cut", "id": 12 }   apply a suggestion that was off
- { "op": "add_cut", "start": 61.2, "end": 64.0, "reason": "" }  remove a new stretch, in ORIGINAL recording seconds
- { "op": "set_audio", "preset": "voz" | "misto" | "leve", "noise": 0-30 }  either field alone is fine; more noise means stronger noise reduction
- { "op": "set_title", "title": "" }
- { "op": "set_edit", ... }  editing choices for this video; send only the fields that change:
    "captions", "zooms", "texts", "transitions", "music", "colour", "broll", "stabilize": true | false
    "captionWords": 1-8 (words per caption), "musicVolume": 0.02-0.5 (0.12 is the usual), "musicQuery": "english search for another kind of music",
    "intensity": "leve" | "media" | "intensa" (replans zooms and texts), "textColour": "#rrggbb"
- { "op": "remove_item", "kind": "zooms" | "texts" | "sections" | "broll", "id": 3 }  drop one planned zoom, text, transition or support image
- { "op": "change_text", "id": 3, "text": "NEW TEXT" }
- { "op": "add_text", "final": 73.5, "text": "UP TO 4 WORDS", "seconds": 2.5 }  a new text on screen, at that second of the FINISHED video
- { "op": "add_zoom", "final": 73.5, "amount": 1.25 }
- { "op": "thumbnail_text", "text": "2 TO 4 WORDS", "note": "how it should look, in the creator's words" }  new thumbnail options with this text ("" = just make new options); "note" carries anything else they asked about the thumbnail (no webcam, use image x, colours…), or ""
- { "op": "unsupported", "what": "" }  for anything else (AI-generated images, publishing, description): not available yet

Do only what was asked. If the request is ambiguous, pick the closest reading and say which in "reply".
Reply with: { "operations": [], "reply": "one or two sentences to the creator, in Brazilian Portuguese, saying what will change" }`;

/** Where in the finished video each cut happens. */
function withFinalTimes(cuts) {
  let removed = 0;
  return cuts.map((c) => {
    const final = c.start - removed;
    if (c.enabled) removed += c.end - c.start;
    return { ...c, final };
  });
}

const EDIT_FLAGS = ["captions", "zooms", "texts", "transitions", "music", "colour", "broll", "stabilize"];
const KINDS = { zooms: "Zoom", texts: "Texto", sections: "Transição", broll: "Imagem de apoio" };

async function run(ctx, video, text) {
  const cuts = withFinalTimes(video.data.cuts ?? []);
  const sound = { ...ctx.settings.audio, ...(video.data.overrides?.audio ?? {}) };
  const editing = { ...ctx.settings.edit, ...(video.data.overrides?.edit ?? {}) };
  const plan = video.data.edit ?? null;
  const toFinal = timeline(video.data.cuts);
  const items = (kind, describe) => (plan?.[kind] ?? []).map((i) => ({ ...i, at: toFinal(i.time) })).filter((i) => i.at !== null).map((i) => `${kind} #${i.id} ${i.enabled === false ? "off" : "ON "} final ${clock(i.at)} (${i.at.toFixed(1)} s)${describe(i)}`);
  const { json } = await ctx.llm.ask({
    role: ROLE,
    model: ctx.settings.models.review,
    signal: ctx.signal,
    prompt: [
      `Creator's request: ${text}`,
      `\nVideo: "${video.title}", original ${clock(video.data.duration)}, finished ${clock(video.data.finalDuration ?? 0)}.`,
      `Sound settings: preset ${sound.preset}, noise reduction ${sound.noise}.`,
      `Editing settings: ${EDIT_FLAGS.map((f) => `${f} ${editing[f] ? "on" : "off"}`).join(", ")}; intensity ${editing.intensity}; ${editing.captionWords} words per caption; music volume ${editing.musicVolume}; music search "${plan?.music?.query ?? ""}"${video.data.editDone?.music ? `, playing "${video.data.editDone.music.title}"` : ""}.`,
      (video.data.thumbnails ?? []).length ? `Thumbnail texts: ${video.data.thumbnails.map((t) => `"${t.text}"`).join(", ")}` : "",
      "\n## Cuts",
      ...cuts.map((c) => `#${c.id} ${c.enabled ? "ON " : "off"} original ${c.start.toFixed(1)}–${c.end.toFixed(1)} s · final ${clock(c.final)} (${c.final.toFixed(1)} s) · ${c.kind}: ${c.reason}`),
      "\n## Editing plan",
      ...items("zooms", (i) => ` · ${i.amount}×`),
      ...items("texts", (i) => ` · "${i.text}" for ${i.seconds} s`),
      ...items("sections", () => " · transition"),
      ...items("broll", (i) => ` · photo of "${i.query}" for ${i.seconds} s`),
      "\n## Shorts suggestions",
      ...(video.data.shorts ?? []).map((s) => `${clock(s.start)}–${clock(s.end)} "${s.title}"`),
    ]
      .filter(Boolean)
      .join("\n"),
  });

  let next = (video.data.cuts ?? []).map((c) => ({ ...c }));
  const overrides = { ...(video.data.overrides ?? {}), audio: { ...(video.data.overrides?.audio ?? {}) }, edit: { ...(video.data.overrides?.edit ?? {}) } };
  const nextPlan = plan ? { ...plan, zooms: [...(plan.zooms ?? [])], texts: [...(plan.texts ?? [])], sections: [...(plan.sections ?? [])], broll: [...(plan.broll ?? [])], music: plan.music ? { ...plan.music } : null } : { zooms: [], texts: [], sections: [], broll: [], music: null, colour: null, stablePath: null, notes: "" };
  const newId = () => Math.max(0, ...["zooms", "texts", "sections", "broll"].flatMap((k) => nextPlan[k].map((i) => i.id))) + 1;
  const toOriginal = original(video.data.cuts);
  const finalLength = video.data.finalDuration ?? video.data.duration;
  const applied = [];
  let touchedCuts = false;
  let touchedAudio = false;
  let touchedEdit = false;
  let replan = false;
  let thumbnailRequest;
  let title = null;
  for (const op of Array.isArray(json.operations) ? json.operations : []) {
    const target = next.find((c) => c.id === Number(op.id));
    if (op.op === "disable_cut" && target) {
      target.enabled = false;
      touchedCuts = true;
      applied.push(`Corte #${target.id} (${clock(target.start)}) desligado`);
    } else if (op.op === "enable_cut" && target) {
      target.enabled = true;
      touchedCuts = true;
      applied.push(`Corte #${target.id} (${clock(target.start)}) ligado`);
    } else if (op.op === "add_cut" && Number(op.end) - Number(op.start) >= 0.25 && Number(op.start) >= 0 && Number(op.end) <= video.data.duration + 0.5) {
      next.push({ id: Math.max(0, ...next.map((c) => c.id)) + 1, start: +Number(op.start).toFixed(3), end: +Number(op.end).toFixed(3), kind: "pedido", reason: String(op.reason || "Pedido por você na revisão"), enabled: true });
      next.sort((a, b) => a.start - b.start);
      touchedCuts = true;
      applied.push(`Novo corte de ${clock(Number(op.start))} a ${clock(Number(op.end))}`);
    } else if (op.op === "set_audio") {
      if (["voz", "misto", "leve"].includes(op.preset)) overrides.audio.preset = op.preset;
      if (Number.isFinite(Number(op.noise))) overrides.audio.noise = Math.max(0, Math.min(30, Number(op.noise)));
      touchedAudio = true;
      applied.push(`Som: ${JSON.stringify(overrides.audio)}`);
    } else if (op.op === "set_title" && String(op.title ?? "").trim()) {
      title = String(op.title).trim();
      applied.push(`Título: ${title}`);
    } else if (op.op === "set_edit") {
      const changes = [];
      for (const flag of EDIT_FLAGS)
        if (typeof op[flag] === "boolean") {
          overrides.edit[flag] = op[flag];
          changes.push(`${flag} ${op[flag] ? "ligado" : "desligado"}`);
          if (flag === "stabilize" && op[flag]) replan = true;
        }
      if (Number.isFinite(Number(op.captionWords)) && op.captionWords !== null && op.captionWords !== undefined) changes.push(`${(overrides.edit.captionWords = Math.max(1, Math.min(8, Math.round(Number(op.captionWords)))))} palavras por legenda`);
      if (Number.isFinite(Number(op.musicVolume)) && op.musicVolume !== null && op.musicVolume !== undefined) changes.push(`volume da música ${(overrides.edit.musicVolume = Math.max(0.02, Math.min(0.5, Number(op.musicVolume))))}`);
      if (typeof op.musicQuery === "string" && op.musicQuery.trim()) {
        nextPlan.music = { ...(nextPlan.music ?? {}), query: op.musicQuery.trim().slice(0, 80) };
        overrides.edit.musicQuery = nextPlan.music.query;
        overrides.edit.music = true;
        changes.push(`música "${nextPlan.music.query}"`);
      }
      if (["leve", "media", "intensa"].includes(op.intensity)) {
        overrides.edit.intensity = op.intensity;
        replan = true;
        changes.push(`intensidade ${op.intensity}`);
      }
      if (/^#[0-9a-f]{6}$/i.test(String(op.textColour ?? ""))) changes.push(`cor do texto ${(overrides.edit.textColour = op.textColour)}`);
      if (changes.length) {
        touchedEdit = true;
        applied.push(`Edição: ${changes.join(", ")}`);
      }
    } else if (op.op === "remove_item" && KINDS[op.kind] && nextPlan[op.kind].some((i) => i.id === Number(op.id))) {
      nextPlan[op.kind] = nextPlan[op.kind].map((i) => (i.id === Number(op.id) ? { ...i, enabled: false } : i));
      touchedEdit = true;
      applied.push(`${KINDS[op.kind]} #${op.id} removido`);
    } else if (op.op === "change_text" && String(op.text ?? "").trim() && nextPlan.texts.some((i) => i.id === Number(op.id))) {
      nextPlan.texts = nextPlan.texts.map((i) => (i.id === Number(op.id) ? { ...i, text: String(op.text).trim().slice(0, 48), enabled: true } : i));
      touchedEdit = true;
      applied.push(`Texto #${op.id}: "${String(op.text).trim()}"`);
    } else if (op.op === "add_text" && String(op.text ?? "").trim() && Number(op.final) >= 0 && Number(op.final) < finalLength) {
      nextPlan.texts.push({ id: newId(), time: +toOriginal(Number(op.final)).toFixed(3), text: String(op.text).trim().slice(0, 48), seconds: Math.max(1.2, Math.min(6, Number(op.seconds) || 2.5)), enabled: true, manual: true });
      nextPlan.texts.sort((a, b) => a.time - b.time);
      overrides.edit.texts = true;
      touchedEdit = true;
      applied.push(`Novo texto "${String(op.text).trim()}" em ${clock(Number(op.final))}`);
    } else if (op.op === "add_zoom" && Number(op.final) >= 0 && Number(op.final) < finalLength) {
      nextPlan.zooms.push({ id: newId(), time: +toOriginal(Number(op.final)).toFixed(3), amount: Math.max(1.1, Math.min(1.45, Number(op.amount) || 1.25)), enabled: true, manual: true });
      nextPlan.zooms.sort((a, b) => a.time - b.time);
      overrides.edit.zooms = true;
      touchedEdit = true;
      applied.push(`Novo zoom em ${clock(Number(op.final))}`);
    } else if (op.op === "thumbnail_text") {
      const wanted = String(op.text ?? "").trim().slice(0, 40);
      const how = String(op.note ?? "").trim().slice(0, 600);
      thumbnailRequest = wanted || how ? { ...(wanted ? { text: wanted } : {}), ...(how ? { note: how } : {}) } : null;
      applied.push(wanted ? `Thumbnails novas com o texto "${wanted}"` : "Thumbnails novas");
    } else if (op.op === "unsupported") {
      applied.push(`Ainda não disponível: ${op.what}`);
    }
  }
  if (title) ctx.db.updateVideo(video.id, { title });
  const reply = String(json.reply ?? "").trim() || (applied.length ? applied.join(". ") : "Não encontrei o que mudar.");
  ctx.log("decision", `${reply} [${applied.join("; ") || "nenhuma alteração"}]`);
  const data = { cuts: next, overrides, dirty: false };
  if (touchedEdit) data.edit = nextPlan;
  if (thumbnailRequest !== undefined) data.thumbnailRequest = thumbnailRequest;
  return {
    reply,
    applied,
    data,
    // The earliest stage whose input changed; everything after it runs again.
    redoFrom: touchedAudio ? "audio" : replan ? "edit" : touchedCuts || touchedEdit ? "assemble" : null,
    redoOnly: thumbnailRequest !== undefined ? "thumbnail" : null,
  };
}

module.exports = { run, withFinalTimes };

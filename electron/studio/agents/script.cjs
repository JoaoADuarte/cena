/**
 * Script agent: hooks, a full script with direction marks, retention points and a call to action,
 * in the creator's own voice. The teleprompter text is derived from the script by code, so it
 * always matches what was approved.
 */
const MARKS = `[PAUSA], [ÊNFASE], [OLHAR PRA CÂMERA], [CORTE SECO], [B-ROLL: what to show], [MÚSICA: tensa/alegre/triste/…], [EFEITO SONORO: which]`;

const ROLE = `You are the Script agent. You write video scripts for one YouTube creator, to be read aloud by them.
- Write in Brazilian Portuguese, in spoken language, the way this creator talks (see the voice profile). It must not sound written by an AI: no stiff connectors, no lists of three for effect, no "neste vídeo vamos explorar".
- Follow the requested tone mix; when it is given in percentages, respect the proportions across the script.
- Use what the research found about hooks, structure and what the audience responded to.
- Direction marks, always in brackets and on the spot where they apply: ${MARKS}. They guide the edit later, so place them where a real editor would.
- Respect the target length: count about WORDS_PER_MINUTE spoken words per minute, marks excluded.

Reply with:
{
  "titles": ["3 title options"],
  "hooks": ["3 different options for the first 5-15 seconds, each complete and ready to say"],
  "body": "the full script after the hook, as plain text with the marks; separate sections with a line starting with '## ' and the section name",
  "retention": [{ "at": "~1:30", "text": "what is said or done here to hold the viewer (open question, turn, 'stay to the end because…')" }],
  "cta": "a natural call to action in the video's tone",
  "estimated_seconds": 0,
  "notes": "one or two sentences to the creator about choices you made"
}`;

const ADJUST = `You are the Script agent revising a script after the creator's feedback.
Apply exactly what was asked and keep everything else as it is, including the direction marks (${MARKS}) and the creator's voice.
Reply with the complete script in the same shape you received: { "titles", "hooks", "body", "retention", "cta", "estimated_seconds", "notes" }, where "notes" says in one sentence what you changed.`;

const WORDS_PER_MINUTE = 150;

/** What goes on the teleprompter: the words to say, with pauses kept as a breath mark. */
function teleprompterText(content, hookIndex = 0) {
  const clean = (text) =>
    String(text ?? "")
      .replace(/\[PAUSA\]/gi, " … ")
      .replace(/\[[^\]\n]*\]/g, "")
      .replace(/^##\s*.*$/gm, "")
      .replace(/[ \t]+/g, " ")
      .replace(/ ?… ?/g, " … ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  return [clean(content.hooks?.[hookIndex] ?? ""), clean(content.body), clean(content.cta)].filter(Boolean).join("\n\n");
}

const countWords = (text) => (String(text).match(/[\p{L}\p{N}]+/gu) ?? []).length;

function normalise(json, wpm) {
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()) : []);
  const content = {
    titles: list(json.titles),
    hooks: list(json.hooks),
    hook: 0,
    body: String(json.body ?? "").trim(),
    retention: Array.isArray(json.retention) ? json.retention.filter((r) => r && r.text).map((r) => ({ at: String(r.at ?? ""), text: String(r.text) })) : [],
    cta: String(json.cta ?? "").trim(),
    notes: String(json.notes ?? "").trim(),
  };
  if (!content.body || !content.hooks.length) throw new Error("O roteiro veio incompleto.");
  // Measured from the words, not the model's own guess.
  content.estimated_seconds = Math.round((countWords(teleprompterText(content)) / wpm) * 60);
  return content;
}

async function write(ctx, script) {
  const wpm = ctx.voice.wpm || WORDS_PER_MINUTE;
  const targetWords = Math.round((script.duration_target / 60) * wpm);
  ctx.log("info", `Escrevendo o roteiro: ${Math.round(script.duration_target / 60 * 10) / 10} min, cerca de ${targetWords} palavras a ${wpm} por minuto.`);
  const { json } = await ctx.llm.ask({
    role: ROLE.replace("WORDS_PER_MINUTE", String(wpm)),
    model: ctx.settings.models.script,
    signal: ctx.signal,
    prompt: [
      `Topic: ${script.topic}`,
      `Tone: ${script.tone}`,
      `Format: ${script.format === "short" ? "Short, vertical, up to 60 seconds: one idea, hook in the first 2 seconds" : "long video"}`,
      `Target length: ${script.duration_target} seconds (about ${targetWords} spoken words)`,
      `Channel niche: ${ctx.settings.channel.niche || "not informed"}`,
      "",
      "## Voice profile of the creator",
      ctx.voice.text || "No profile yet: write naturally, informal Brazilian Portuguese, short sentences.",
      "",
      "## Research report",
      script.research ? JSON.stringify(script.research, null, 1) : "No research available.",
      ...(ctx.style ? ["", ctx.style] : []),
    ].join("\n"),
  });
  const content = normalise(json, wpm);
  const drift = Math.abs(content.estimated_seconds - script.duration_target) / script.duration_target;
  ctx.log(drift > 0.25 ? "warn" : "decision", `Roteiro pronto: ${content.hooks.length} ganchos, ${countWords(content.body)} palavras, duração estimada ${content.estimated_seconds} s (alvo ${script.duration_target} s). ${content.notes}`);
  return content;
}

async function adjust(ctx, script, instruction) {
  ctx.log("info", `Ajustando o roteiro: "${instruction}".`);
  const { json } = await ctx.llm.ask({
    role: ADJUST,
    model: ctx.settings.models.script,
    signal: ctx.signal,
    prompt: [
      `Creator's request: ${instruction}`,
      `Tone: ${script.tone} · target length: ${script.duration_target} seconds · words per minute: ${ctx.voice.wpm || WORDS_PER_MINUTE}`,
      "",
      "## Voice profile",
      ctx.voice.text || "No profile yet.",
      "",
      "## Current script",
      JSON.stringify(script.content, null, 1),
    ].join("\n"),
  });
  const content = { ...normalise(json, ctx.voice.wpm || WORDS_PER_MINUTE), hook: script.content?.hook ?? 0 };
  if (content.hook >= content.hooks.length) content.hook = 0;
  ctx.log("decision", `Roteiro ajustado. ${content.notes}`);
  return content;
}

module.exports = { write, adjust, teleprompterText, countWords, WORDS_PER_MINUTE };

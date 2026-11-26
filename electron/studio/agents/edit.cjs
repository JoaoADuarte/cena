/**
 * Edit agent: decides what goes on top of the cut video (punch-in zooms, words on screen, transitions between
 * subjects, captions, background music, colour, B-roll) and later applies that plan to the Cena project.
 * The plan is kept in the ORIGINAL recording's times, so it survives the creator turning cuts on and off.
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { FFMPEG } = require("../../media.cjs");
const { ff } = require("../ffmpeg.cjs");
const { sentences, clock } = require("./cut.cjs");

const ROLE = `You are the Edit agent. You receive the transcript of a video that was already cut (one numbered sentence per line, with its time) and plan the editing that makes it hold attention, the way a good YouTube editor would. You do not see the picture, only what is said.

Plan:
- "zooms": quick punch-in zooms on the word that carries a punchline, a surprise, a number or a strong opinion. Roughly one every 10 to 20 seconds of speech, never two within 4 seconds, none in a sentence that is just connective. "amount" from 1.12 (subtle) to 1.4 (strong, rare).
- "texts": short words on screen that reinforce what is being said: the name of a list item ("ERRO Nº 1"), a number, a key term. At most 4 words, upper case, in the language of the video. At most one every 20 seconds; fewer is fine.
- "sections": ids of the sentences where a NEW subject or list item starts (not the first sentence). A soft transition goes there. Usually 0 to 6 in a whole video.
- "music": a search query in English for instrumental background music that fits the tone (for example "upbeat funk instrumental", "calm lofi beat", "epic cinematic trailer"), and the mood in Portuguese.
- "broll": moments where the speech names a concrete, visual thing that a stock photo could show for a few seconds (an object, a place, an animal). The query is in English, 2 to 4 words. At most one every 30 seconds, never in the first 5 seconds, and only when a photo would clearly help. An empty list is a good answer.

"sentence" is always the number of a listed sentence. "word" is one word copied exactly from that sentence: the moment of the zoom or text.

Reply with:
{ "zooms": [{ "sentence": 4, "word": "nunca", "amount": 1.25 }],
  "texts": [{ "sentence": 7, "word": "primeiro", "text": "ERRO Nº 1", "seconds": 2.5 }],
  "sections": [9, 21],
  "music": { "query": "", "mood": "" },
  "broll": [{ "sentence": 12, "word": "fogueira", "query": "campfire night forest", "seconds": 3.5 }],
  "notes": "one or two sentences to the creator about the editing choices" }`;

const round = (n) => Math.round(n * 1000) / 1000;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const plain = (text) => String(text ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

function mergedCuts(cuts) {
  const out = [];
  for (const c of (cuts ?? []).filter((x) => x.enabled).sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && c.start <= last.end) last.end = Math.max(last.end, c.end);
    else out.push({ start: c.start, end: c.end });
  }
  return out;
}

/** Original time → time in the finished video, or null when that moment was cut out. */
function timeline(cuts) {
  const on = mergedCuts(cuts);
  return (t) => {
    let removed = 0;
    for (const c of on) {
      if (t >= c.end) removed += c.end - c.start;
      else if (t > c.start) return null;
      else break;
    }
    return t - removed;
  };
}

/** Time in the finished video → time in the original recording. */
function original(cuts) {
  const on = mergedCuts(cuts);
  return (t) => {
    let at = t;
    for (const c of on) {
      if (c.start <= at) at += c.end - c.start;
      else break;
    }
    return at;
  };
}

function readWords(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "transcricao.json"), "utf8")).words ?? [];
  } catch {
    return [];
  }
}

/** Words that stay in the video, with their original times. */
function keptWords(words, cuts) {
  const toFinal = timeline(cuts);
  return words.filter((w) => toFinal((w.start + w.end) / 2) !== null);
}

// --- Colour: measured, not guessed ---------------------------------------------------------------
function frameStats(file, time) {
  return new Promise((resolve) => {
    execFile(FFMPEG, ["-hide_banner", "-ss", String(time), "-i", file, "-frames:v", "1", "-vf", "scale=320:-2,signalstats,metadata=print:file=-", "-f", "null", "-"], { windowsHide: true, timeout: 60_000 }, (err, stdout) => {
      const read = (key) => Number(new RegExp(`signalstats\\.${key}=([\\d.]+)`).exec(String(stdout))?.[1]);
      const stats = { y: read("YAVG"), low: read("YLOW"), high: read("YHIGH"), sat: read("SATAVG") };
      resolve(err || !Number.isFinite(stats.y) ? null : stats);
    });
  });
}

/** A mild correction towards a well exposed, lively picture. Null when the picture is already fine. */
async function measureColour(file, duration) {
  const samples = [];
  for (let i = 0; i < 6; i++) {
    const stats = await frameStats(file, duration * (0.1 + 0.16 * i));
    if (stats) samples.push(stats);
  }
  if (samples.length < 3) return null;
  const avg = (key) => samples.reduce((sum, s) => sum + s[key], 0) / samples.length;
  const adjust = {
    brightness: +clamp(1 + ((118 - avg("y")) / 255) * 0.8, 0.94, 1.16).toFixed(2),
    contrast: +clamp(1 + ((150 - (avg("high") - avg("low"))) / 255) * 0.6, 1, 1.14).toFixed(2),
    saturation: +clamp(1 + ((55 - avg("sat")) / 255) * 1.4, 1, 1.2).toFixed(2),
  };
  const changed = Object.values(adjust).some((v) => Math.abs(v - 1) >= 0.03);
  return changed ? { adjust, measured: { luma: Math.round(avg("y")), range: Math.round(avg("high") - avg("low")), saturation: Math.round(avg("sat")) } } : null;
}

// --- Stabilization: on a copy, never on the recording itself ------------------------------------------
async function stabilize(ctx, video, dir) {
  const out = path.join(dir, "estabilizado.mp4");
  const total = video.data.duration;
  ctx.progress(0.05, "Estabilizando: analisando o movimento");
  // File names relative to the folder: the filter reads its path with rules of its own.
  await ff(["-i", video.source_path, "-an", "-vf", "vidstabdetect=shakiness=5:accuracy=15:result=estabilizacao.trf", "-f", "null", "-"], { signal: ctx.signal, total, cwd: dir, onProgress: (p) => ctx.progress(0.05 + 0.3 * p, "Estabilizando: analisando o movimento") });
  const pass = (codec) =>
    ff(["-i", video.source_path, "-map", "0:v:0", "-map", "0:a?", "-vf", "vidstabtransform=input=estabilizacao.trf:smoothing=12:zoom=1:optzoom=1,unsharp=5:5:0.6:3:3:0.3", ...codec, "-pix_fmt", "yuv420p", "-c:a", "copy", "estabilizado.mp4"], {
      signal: ctx.signal,
      total,
      cwd: dir,
      onProgress: (p) => ctx.progress(0.35 + 0.35 * p, "Estabilizando: gravando a cópia"),
    });
  const software = ["-c:v", "libx264", "-preset", "fast", "-crf", "16"];
  try {
    await pass(ctx.settings.render.gpu ? ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "18", "-b:v", "0"] : software);
  } catch (err) {
    if (ctx.signal.aborted || !ctx.settings.render.gpu) throw err;
    await pass(software);
  }
  fs.rm(path.join(dir, "estabilizacao.trf"), { force: true }, () => {});
  return out;
}

// --- The plan ---------------------------------------------------------------------------------------
async function run(ctx) {
  const { video, dir } = ctx;
  const cfg = ctx.settings.edit;
  const words = keptWords(readWords(dir), video.data.cuts);
  const lines = sentences(words);
  const plan = { zooms: [], texts: [], sections: [], broll: [], music: null, colour: null, stablePath: null, notes: "" };

  if (cfg.stabilize) {
    try {
      plan.stablePath = await stabilize(ctx, video, dir);
      ctx.log("info", "Cópia estabilizada pronta (o arquivo original não foi alterado).");
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.log("warn", `Não consegui estabilizar (${err.message}). Sigo com a imagem original.`);
    }
  }

  ctx.progress(0.72, "Medindo cor e luz");
  plan.colour = await measureColour(video.source_path, video.data.duration);
  if (plan.colour) ctx.log("info", `Cor: brilho ${plan.colour.adjust.brightness}, contraste ${plan.colour.adjust.contrast}, saturação ${plan.colour.adjust.saturation} (medido em 6 quadros).`);
  else ctx.log("info", "Cor: a imagem já está equilibrada, sem correção.");

  if (lines.length < 3) {
    ctx.log("info", "Quase não há fala: sem zooms, textos ou legendas planejados. Música e cor seguem as configurações.");
    plan.music = { query: cfg.musicQuery || "ambient background instrumental", mood: "neutra" };
    return plan;
  }

  ctx.progress(0.78, "Planejando a edição");
  const toFinal = timeline(video.data.cuts);
  let json;
  try {
    ({ json } = await ctx.llm.ask({
    role: ROLE,
    model: ctx.settings.models.edit,
    signal: ctx.signal,
    prompt: [
      `Video: "${video.title}". Finished length about ${clock(toFinal(video.data.duration) ?? video.data.duration)}.`,
      ctx.settings.channel.niche ? `Channel: ${ctx.settings.channel.niche}` : "",
      video.data.summary ? `Summary: ${video.data.summary}` : "",
      `Editing intensity asked by the creator: ${cfg.intensity} (leve = few, discreet effects; media = balanced; intensa = fast paced, many zooms and texts).`,
      ctx.style ? `
${ctx.style}
(Follow this style where it fits this video; the creator's instructions below win.)` : "",
      ctx.brief ? `Creator's instructions for this video (follow what concerns zooms, texts on screen, transitions, music and support images; the rest is for other agents): ${ctx.brief}` : "",
      "\n## Transcript",
      ...lines.map((s) => `${s.id}. [${clock(toFinal(s.start) ?? 0)}] ${s.text}`),
    ]
      .filter(Boolean)
      .join("\n"),
    }));
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    // Captions, colour and music do not depend on the plan: the video is still edited.
    ctx.log("warn", `Não consegui planejar zooms e textos (${err.message}). Sigo com legendas, cor e música.`);
    plan.music = { query: cfg.musicQuery || "upbeat background instrumental", mood: "" };
    return plan;
  }

  /** The moment a plan item points at: its word inside its sentence, or the start of the sentence. */
  const moment = (item) => {
    const line = lines.find((s) => s.id === Number(item?.sentence));
    if (!line) return null;
    const inside = words.filter((w) => w.start >= line.start - 0.01 && w.end <= line.end + 0.01);
    const wanted = plain(item.word);
    const hit = wanted ? (inside.find((w) => plain(w.text) === wanted) ?? inside.find((w) => plain(w.text).includes(wanted))) : null;
    return round((hit ?? line).start);
  };
  const list = (value) => (Array.isArray(value) ? value : []);
  let id = 0;
  const spaced = (items, gap) => {
    const out = [];
    for (const item of items.sort((a, b) => a.time - b.time)) if (!out.length || item.time - out[out.length - 1].time >= gap) out.push(item);
    return out.map((item) => ({ id: ++id, ...item, enabled: true }));
  };

  plan.zooms = spaced(
    list(json.zooms)
      .map((z) => ({ time: moment(z), amount: +clamp(Number(z.amount) || 1.25, 1.1, 1.45).toFixed(2) }))
      .filter((z) => z.time !== null),
    3.5,
  );
  plan.texts = spaced(
    list(json.texts)
      .map((t) => ({ time: moment(t), text: String(t.text ?? "").trim().slice(0, 48), seconds: clamp(Number(t.seconds) || 2.5, 1.2, 5) }))
      .filter((t) => t.time !== null && t.text),
    6,
  );
  plan.sections = spaced(
    list(json.sections)
      .map((s) => ({ time: moment({ sentence: s }) }))
      .filter((s) => s.time !== null && s.time > lines[0].start + 3),
    8,
  );
  plan.broll = spaced(
    list(json.broll)
      .map((b) => ({ time: moment(b), query: String(b.query ?? "").trim().slice(0, 60), seconds: clamp(Number(b.seconds) || 3.5, 2, 6) }))
      .filter((b) => b.time !== null && b.query && b.time > lines[0].start + 5),
    20,
  );
  plan.music = { query: cfg.musicQuery || String(json.music?.query ?? "").trim() || "upbeat background instrumental", mood: String(json.music?.mood ?? "").trim() };
  plan.notes = String(json.notes ?? "").trim();
  ctx.log("decision", `Plano de edição: ${plan.zooms.length} zooms, ${plan.texts.length} textos, ${plan.sections.length} transições, ${plan.broll.length} imagens de apoio, música "${plan.music.query}". ${plan.notes}`);
  return plan;
}

// --- Captions ------------------------------------------------------------------------------------------
/** Short captions from the word timings, in the finished video's times. */
function captionLines(words, cuts, maxWords) {
  const toFinal = timeline(cuts);
  const out = [];
  let current = null;
  for (const w of words) {
    const start = toFinal(w.start);
    const end = toFinal(w.end);
    if (start === null || end === null || !String(w.text).trim()) continue;
    if (current && (start - current.end > 0.6 || current.words.length >= maxWords)) current = null;
    if (!current) {
      current = { start, end, words: [] };
      out.push(current);
    }
    current.words.push(String(w.text).trim());
    current.end = Math.max(current.end, end);
    if (/[.!?…]$/.test(w.text) || (/[,;:]$/.test(w.text) && current.words.length >= Math.ceil(maxWords / 2))) current = null;
  }
  const lines = out.map((c) => ({ start: c.start, end: c.end, text: c.words.join(" ").replace(/[.,;:]+$/, "") })).filter((c) => c.text);
  for (let i = 0; i < lines.length; i++) {
    const next = lines[i + 1];
    // Hold a caption a moment after the last word, but never over the next one.
    lines[i].end = Math.min(next ? next.start : lines[i].end + 0.35, Math.max(lines[i].end + 0.15, lines[i].start + 0.45));
    lines[i].start = round(lines[i].start);
    lines[i].end = round(lines[i].end);
  }
  return lines.filter((c) => c.end - c.start >= 0.12);
}

// --- B-roll: openly licensed photos -----------------------------------------------------------------------
async function findImage(query, file, signal) {
  const url = new URL("https://api.openverse.org/v1/images/");
  url.searchParams.set("q", query);
  url.searchParams.set("license_type", "commercial");
  url.searchParams.set("category", "photograph");
  url.searchParams.set("aspect_ratio", "wide");
  url.searchParams.set("size", "large");
  url.searchParams.set("mature", "false");
  url.searchParams.set("page_size", "5");
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
  if (!res.ok) throw new Error(`Openverse respondeu HTTP ${res.status}`);
  for (const item of (await res.json()).results ?? []) {
    if (!/^https:\/\//.test(item.url ?? "") || !["jpg", "jpeg", "png"].includes(String(item.filetype ?? "").toLowerCase())) continue;
    try {
      const image = await fetch(item.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
      const type = image.headers.get("content-type") ?? "";
      if (!image.ok || !/^image\/(jpeg|png)/.test(type)) continue;
      const bytes = Buffer.from(await image.arrayBuffer());
      if (bytes.length < 20_000 || bytes.length > 25_000_000) continue;
      const target = `${file}.${/png/.test(type) ? "png" : "jpg"}`;
      fs.writeFileSync(target, bytes);
      return { path: target, title: item.title || "Sem título", creator: item.creator || "Autor desconhecido", license: String(item.license ?? "").toUpperCase(), needsCredit: !["cc0", "pdm"].includes(item.license), url: item.foreign_landing_url ?? null };
    } catch {
      if (signal.aborted) throw new Error("Interrompido.");
    }
  }
  return null;
}

// --- Applying the plan to the project ------------------------------------------------------------------------
/**
 * Called by the assembly stage once the cuts are in. `tool` runs an editor tool in the hidden Cena.
 * Every feature is independent: one that fails is reported and the video is still made.
 */
async function apply({ tool, ctx, video, dir, pictureId, opts }) {
  const plan = video.data.edit ?? {};
  const cuts = video.data.cuts;
  const toFinal = timeline(cuts);
  const done = { zooms: 0, texts: 0, transitions: 0, captions: 0, broll: 0, music: null, colour: false };
  const credits = [];
  const attempt = async (label, work) => {
    try {
      await work();
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.log("warn", `${label} não aplicado: ${err.message}`);
    }
  };
  const mainClips = async () => {
    const project = await tool("get_project");
    const track = project.tracks.filter((t) => t.kind === "video").find((t) => t.clips.some((c) => c.materialId === pictureId));
    return { project, clips: (track?.clips ?? []).filter((c) => c.materialId === pictureId).sort((a, b) => a.start - b.start) };
  };
  const on = (items) =>
    (items ?? [])
      .filter((i) => i.enabled !== false)
      .map((i) => ({ ...i, at: toFinal(i.time) }))
      .filter((i) => i.at !== null);
  const batch = async (operations) => (operations.length ? tool("batch", { operations }, 120_000) : { results: [] });
  let { project, clips } = await mainClips();
  const total = project.duration;

  if (opts.colour && plan.colour?.adjust && clips.length)
    await attempt("Cor", async () => {
      await tool("update_clip", { clipIds: clips.map((c) => c.id), adjust: plan.colour.adjust });
      done.colour = true;
    });

  if (opts.transitions)
    await attempt("Transições", async () => {
      for (const section of on(plan.sections)) {
        ({ clips } = await mainClips());
        let before = clips.find((c, i) => clips[i + 1] && Math.abs(c.end - section.at) <= 2 && Math.abs(clips[i + 1].start - c.end) < 0.01);
        if (!before) {
          const holder = clips.find((c) => section.at - c.start >= 1 && c.end - section.at >= 1);
          if (!holder) continue;
          await tool("split_clip", { time: section.at, clipId: holder.id });
          ({ clips } = await mainClips());
          before = clips.find((c) => Math.abs(c.end - section.at) < 0.05);
        }
        if (!before || before.end - before.start < 0.8) continue;
        await tool("set_transition", { clipId: before.id, type: opts.transition, duration: 0.4 });
        done.transitions++;
      }
    });

  if (opts.zooms)
    await attempt("Zooms", async () => {
      ({ clips } = await mainClips());
      const operations = [];
      for (const zoom of on(plan.zooms)) {
        const clip = clips.find((c) => zoom.at >= c.start + 0.05 && zoom.at < c.end - 0.5);
        if (clip) operations.push({ tool: "punch_zoom", args: { clipId: clip.id, time: zoom.at, amount: zoom.amount, hold: 0.7 } });
      }
      await batch(operations);
      done.zooms = operations.length;
    });

  if (opts.broll)
    await attempt("Imagens de apoio", async () => {
      const folder = path.join(dir, "apoio");
      fs.mkdirSync(folder, { recursive: true });
      for (const shot of on(plan.broll)) {
        if (shot.at + shot.seconds > total - 0.5) continue;
        const found = await findImage(shot.query, path.join(folder, String(shot.id)), ctx.signal);
        if (!found) {
          ctx.log("warn", `Imagem de apoio: nada livre encontrado para "${shot.query}".`);
          continue;
        }
        const imported = await tool("import_media", { paths: [found.path] }, 120_000);
        const material = imported.materials?.[0];
        if (!material) continue;
        const clip = await tool("add_clip", { materialId: material.id, start: shot.at, duration: shot.seconds, overlay: true });
        // "1" fits the picture inside the canvas; fill it instead, then drift in slowly.
        const ratios = material.width && material.height ? [project.width / material.width, project.height / material.height] : [1, 1];
        const fit = Math.max(...ratios) / Math.min(...ratios);
        await batch([
          { tool: "set_keyframes", args: { clipId: clip.id, property: "scale", keyframes: [{ time: 0, value: fit, easing: "linear" }, { time: shot.seconds, value: fit * 1.08 }] } },
          { tool: "set_keyframes", args: { clipId: clip.id, property: "opacity", keyframes: [{ time: 0, value: 0, easing: "easeOut" }, { time: 0.25, value: 1 }, { time: shot.seconds - 0.25, value: 1, easing: "easeIn" }, { time: shot.seconds, value: 0 }] } },
        ]);
        credits.push({ kind: "imagem", title: found.title, creator: found.creator, license: found.license, url: found.url, needsCredit: found.needsCredit });
        done.broll++;
      }
    });

  if (opts.texts)
    await attempt("Textos", async () => {
      const items = on(plan.texts).filter((t) => t.at + 0.8 < total);
      const added = await batch(
        items.map((t) => ({
          tool: "add_text",
          args: {
            content: t.text,
            start: t.at,
            duration: Math.min(t.seconds, total - t.at),
            style: { fontFamily: opts.font, fontSize: 96, bold: true, color: opts.textColour, strokeColor: "#000000", strokeWidth: 10, align: "center" },
            transform: { x: 0, y: -0.58 },
          },
        })),
      );
      await batch(
        added.results.flatMap((clip, i) => {
          const length = Math.min(items[i].seconds, total - items[i].at);
          return [
            { tool: "set_keyframes", args: { clipId: clip.id, property: "scale", keyframes: [{ time: 0, value: 0.5, easing: "easeOut" }, { time: 0.14, value: 1.12, easing: "easeInOut" }, { time: 0.26, value: 1 }] } },
            { tool: "set_keyframes", args: { clipId: clip.id, property: "opacity", keyframes: [{ time: 0, value: 0, easing: "easeOut" }, { time: 0.1, value: 1 }, { time: Math.max(0.2, length - 0.2), value: 1, easing: "easeIn" }, { time: length, value: 0 }] } },
          ];
        }),
      );
      done.texts = items.length;
    });

  if (opts.captions)
    await attempt("Legendas", async () => {
      const lines = captionLines(readWords(dir), cuts, opts.captionWords).filter((l) => l.end <= total + 0.2);
      if (!lines.length) return;
      const result = await tool("add_captions", { lines, replace: true, y: 0.7, style: { fontFamily: opts.font, fontSize: 68, bold: true, color: "#ffffff", strokeColor: "#000000", strokeWidth: 9, align: "center" } }, 120_000);
      done.captions = result.added ?? 0;
      if (!opts.captionPop) return;
      const after = await tool("get_project");
      const captions = after.tracks.filter((t) => t.role === "captions").flatMap((t) => t.clips);
      // Each caption pops in: small to full size in a tenth of a second.
      for (let i = 0; i < captions.length; i += 150)
        await batch(captions.slice(i, i + 150).map((c) => ({ tool: "set_keyframes", args: { clipId: c.id, property: "scale", keyframes: [{ time: 0, value: 0.8, easing: "easeOut" }, { time: Math.min(0.1, (c.end - c.start) / 2), value: 1 }] } })));
    });

  if (opts.music && plan.music?.query)
    await attempt("Música", async () => {
      // Long queries often find nothing: try again with fewer words before giving up.
      const terms = plan.music.query.split(/\s+/).filter(Boolean);
      const queries = [...new Set([plan.music.query, terms.slice(0, 2).join(" "), terms[0] + " instrumental", "background music", "instrumental"])];
      let usable = [];
      for (const query of queries) {
        const found = await tool("search_sounds", { category: "music", query, commercial: true }, 200_000).catch(() => ({ results: [] }));
        usable = (found.results ?? []).filter((r) => !r.duration || r.duration >= 45);
        if (usable.length) break;
      }
      const pick = usable.find((r) => r.duration >= Math.min(total, 120)) ?? usable[0];
      if (!pick) throw new Error(`nenhuma música livre para "${plan.music.query}"`);
      const pieces = [];
      let at = 0;
      while (at < total - 0.5 && pieces.length < 20) {
        const clip = await tool("add_sound", { soundId: pick.id, start: at }, 300_000);
        if (!(clip.end > clip.start)) break;
        pieces.push(clip);
        at = clip.end;
      }
      if (!pieces.length) throw new Error("a música não pôde ser baixada");
      const last = pieces[pieces.length - 1];
      if (last.end > total) pieces[pieces.length - 1] = await tool("trim_clip", { clipId: last.id, end: total });
      const low = opts.musicVolume;
      const high = Math.min(0.5, low * 2.5);
      // Ducking from the transcript: quiet under speech, up in the gaps.
      const speech = [];
      for (const line of captionLines(readWords(dir), cuts, 12)) {
        const prev = speech[speech.length - 1];
        if (prev && line.start - prev.end < 1.5) prev.end = line.end;
        else speech.push({ start: line.start, end: line.end });
      }
      for (const [i, clip] of pieces.entries()) {
        const length = clip.end - clip.start;
        const points = [{ time: 0, value: speech.some((s) => s.start - 0.4 <= clip.start && s.end > clip.start) ? low : high }];
        for (const s of speech) {
          const from = s.start - clip.start;
          const to = s.end - clip.start;
          if (to < 0 || from > length) continue;
          if (from - 0.4 > 0) points.push({ time: from - 0.4, value: high, easing: "easeInOut" });
          if (from > 0) points.push({ time: from, value: low });
          if (to + 0.2 < length) points.push({ time: to + 0.2, value: low, easing: "easeInOut" });
          if (to + 1 < length) points.push({ time: to + 1, value: high });
        }
        points.sort((a, b) => a.time - b.time);
        const keyframes = points.filter((p, n) => n === 0 || p.time - points[n - 1].time > 0.02).map((p) => ({ ...p, time: round(p.time) }));
        await tool("update_clip", { clipIds: [clip.id], volume: low, ...(i === 0 ? { fadeIn: 1.5 } : {}), ...(i === pieces.length - 1 ? { fadeOut: Math.min(3, length / 2) } : {}) });
        await tool("set_keyframes", { clipId: clip.id, property: "volume", keyframes });
      }
      done.music = { title: pick.title, creator: pick.creator, license: pick.license, needsCredit: Boolean(pick.needsCredit), query: plan.music.query };
      credits.push({ kind: "música", title: pick.title, creator: pick.creator, license: pick.license, needsCredit: Boolean(pick.needsCredit) });
    });

  ctx.log(
    "info",
    `Edição aplicada: ${done.zooms} zooms, ${done.texts} textos, ${done.transitions} transições, ${done.captions} legendas${done.broll ? `, ${done.broll} imagens de apoio` : ""}${done.music ? `, música "${done.music.title}" de ${done.music.creator} (${done.music.license})` : ", sem música"}${done.colour ? ", cor corrigida" : ""}.`,
  );
  return { done, credits };
}

module.exports = { run, apply, timeline, original, captionLines, keptWords, readWords, mergedCuts };

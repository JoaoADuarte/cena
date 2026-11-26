/**
 * Audio agent: finds out what each sound track of the recording is (the creator's voice, the voice chat, the
 * game), treats and levels every one on its own, and writes one finished file per track. The assembly puts
 * each on its own track of the project, as the editor does, so any of them can still be changed by hand.
 *
 * A recording from OBS carries those tracks in an order only the creator knows. Guessing the order ruins the
 * video (the game treated as a voice, the voices left as they were), so the tracks are told apart by how they
 * sound: speech has gaps, a game hardly ever does; and among the tracks with speech, the one whose timbre
 * changes least from phrase to phrase has a single person on a single microphone: the creator.
 *
 * Levels are set with a plain measured gain and a limiter. FFmpeg's "loudnorm" falls back to its dynamic mode
 * when the gain it needs would clip, and that mode pumps the voice up and down.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { ff } = require("../ffmpeg.cjs");
const { FFMPEG } = require("../../media.cjs");

const TARGET = { I: -14, TP: -1.5 };
/** The creator's voice before the final trim. With the chat and the game beside it the mix lands near the target. */
const VOICE_LEVEL = -16;
/** A track has speech when at least this share of it is quiet. */
const VOICE_QUIET = 0.22;
const ROLES = ["voz", "conversa", "jogo", "misto", "fora"];
const ROLE_LABEL = { voz: "sua voz", conversa: "conversa (Discord)", jogo: "jogo", misto: "jogo e voz juntos", fora: "não usada" };
const STEM_NAME = { voz: "minha-voz", conversa: "conversa", jogo: "jogo", misto: "som" };
const SPOKEN = ["voz", "conversa", "misto"];

const PRESETS = {
  voz: { label: "Voz (limpeza completa)" },
  misto: { label: "Jogo e voz na mesma faixa (só o que não estraga o jogo)" },
  leve: { label: "Leve (só volume)" },
};

/** What is done to a track before its level is set. `gain` brings it near working level first. */
function chain(role, gain, { noise = 12, clean = true, deepFiltered = false } = {}) {
  const pre = Math.abs(gain) > 0.1 ? [`volume=${gain.toFixed(2)}dB`] : [];
  if (!clean) return ["highpass=f=30", ...pre];
  if (role === "voz") {
    // Gentle on purpose: heavy noise reduction, gates and de-essers are what make a voice sound like a robot.
    const denoise = !deepFiltered && noise > 0 ? [`afftdn=nr=${Math.min(10, noise)}:nf=-50`] : [];
    return ["highpass=f=80", ...pre, ...denoise, "acompressor=threshold=-24dB:ratio=3:attack=10:release=200"];
  }
  // The chat arrives already cleaned by its own program: only its level is evened out.
  if (role === "conversa") return ["highpass=f=80", ...pre, "acompressor=threshold=-24dB:ratio=3:attack=10:release=200"];
  if (role === "misto") return ["highpass=f=40", ...pre, "acompressor=threshold=-20dB:ratio=2:attack=15:release=250"];
  return ["highpass=f=30", ...pre];
}

/** Integrated loudness and peak from the summary "ebur128" prints at the end. */
function loudness(log) {
  const at = log.lastIndexOf("Integrated loudness:");
  if (at < 0) return null;
  const tail = log.slice(at);
  const I = Number(/I:\s+(-?[\d.]+) LUFS/.exec(tail)?.[1]);
  const peak = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(tail)?.[1]);
  return Number.isFinite(I) ? { I, peak: Number.isFinite(peak) ? peak : null } : null;
}

/** Where to listen: `count` two-minute stretches, or the whole file when it is short. */
function windows(duration, count = 3) {
  if (duration <= 420) return [{ at: 0, length: Math.max(1, duration) }];
  return Array.from({ length: count }, (_, i) => ({ at: Math.round(duration * (0.12 + (0.76 * i) / (count - 1))), length: 120 }));
}

// --- One voice or several ------------------------------------------------------------------------------
const SR = 16000;
const FRAME = 512;
const HOP = 256;
const BANDS = 18;
const mel = (f) => 2595 * Math.log10(1 + f / 700);
const hertz = (m) => 700 * (10 ** (m / 2595) - 1);
const EDGES = Array.from({ length: BANDS + 1 }, (_, i) => Math.round((hertz(mel(100) + ((mel(7000) - mel(100)) * i) / BANDS) / SR) * FRAME));
const HANN = Float64Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME));

function powerSpectrum(re) {
  const im = new Float64Array(FRAME);
  for (let i = 1, j = 0; i < FRAME; i++) {
    let bit = FRAME >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [re[i], re[j]] = [re[j], re[i]];
  }
  for (let len = 2; len <= FRAME; len <<= 1) {
    const step = (-2 * Math.PI) / len;
    for (let i = 0; i < FRAME; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const c = Math.cos(step * k);
        const s = Math.sin(step * k);
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * c - im[b] * s;
        const xi = re[b] * s + im[b] * c;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
  for (let i = 0; i < FRAME / 2; i++) re[i] = re[i] * re[i] + im[i] * im[i];
  return re;
}

function samples(file, index, w, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ["-hide_banner", "-nostdin", "-loglevel", "error", "-ss", String(w.at), "-t", String(w.length), "-i", file, "-vn", "-map", `0:a:${index}`, "-ac", "1", "-ar", String(SR), "-f", "s16le", "-"], { windowsHide: true });
    const chunks = [];
    const stop = () => child.kill();
    signal?.addEventListener("abort", stop);
    child.stdout.on("data", (c) => chunks.push(c));
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", () => {
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted) return reject(new Error("Interrompido."));
      const all = Buffer.concat(chunks);
      resolve(new Int16Array(all.buffer, all.byteOffset, all.length >> 1));
    });
  });
}

/** The shape of the spectrum of each phrase in a stretch, level taken out. */
function phraseShapes(x) {
  const frames = [];
  for (let s = 0; s + FRAME < x.length; s += HOP) {
    let e = 0;
    for (let i = 0; i < FRAME; i++) e += x[s + i] * x[s + i];
    frames.push({ s, rms: Math.sqrt(e / FRAME) });
  }
  if (!frames.length) return [];
  const sorted = frames.map((f) => f.rms).sort((a, b) => a - b);
  const gate = Math.max(5, sorted[Math.floor(sorted.length * 0.95)] * 0.2);
  const shapes = [];
  let run = [];
  let gap = 0;
  const flush = () => {
    // Shorter than about 0.6 s is a cough or a click, not a phrase.
    if (run.length >= 40) {
      const sum = new Float64Array(BANDS);
      for (const f of run) {
        const frame = new Float64Array(FRAME);
        for (let i = 0; i < FRAME; i++) frame[i] = x[f.s + i] * HANN[i];
        const power = powerSpectrum(frame);
        for (let b = 0; b < BANDS; b++) for (let k = EDGES[b]; k < EDGES[b + 1]; k++) sum[b] += power[k];
      }
      const db = Array.from(sum, (e) => 10 * Math.log10(e / run.length + 1e-9));
      const mean = db.reduce((a, v) => a + v, 0) / BANDS;
      shapes.push(db.map((v) => v - mean));
    }
    run = [];
  };
  for (const f of frames) {
    if (f.rms > gate) {
      run.push(f);
      gap = 0;
    } else if (++gap > 20) flush();
  }
  flush();
  return shapes;
}

/**
 * How much the timbre changes from one phrase to the next, in dB. One person on one microphone stays near 2-3;
 * several people, each on their own microphone, go past 4. Null: too little speech to tell.
 */
async function timbreSpread(file, index, duration, signal) {
  let total = 0;
  let weight = 0;
  for (const w of windows(duration, 5)) {
    const shapes = phraseShapes(await samples(file, index, w, signal));
    if (shapes.length < 4) continue;
    let spread = 0;
    for (let b = 0; b < BANDS; b++) {
      const column = shapes.map((v) => v[b]);
      const mean = column.reduce((a, v) => a + v, 0) / column.length;
      spread += Math.sqrt(column.reduce((a, v) => a + (v - mean) ** 2, 0) / column.length);
    }
    total += (spread / BANDS) * shapes.length;
    weight += shapes.length;
  }
  return weight ? total / weight : null;
}

/**
 * Listens to every sound track of `file`. Returns [{ index, loudness (LUFS), quiet (0-1), spread, role }].
 * `wanted`: roles the creator fixed in the settings, by track ("auto" or missing: decide here).
 */
async function analyse(file, count, duration, { signal, wanted = [] } = {}) {
  const tracks = [];
  for (let index = 0; index < count; index++) {
    let energy = 0;
    let heard = 0;
    let quiet = 0;
    let total = 0;
    for (const w of windows(duration)) {
      const from = ["-ss", String(w.at), "-t", String(w.length), "-i", file, "-vn", "-map", `0:a:${index}`];
      const level = loudness(await ff([...from, "-af", "ebur128", "-f", "null", "-"], { signal }));
      total += w.length;
      if (!level || level.I < -65) {
        quiet += w.length;
        continue;
      }
      energy += 10 ** (level.I / 10) * w.length;
      heard += w.length;
      const log = await ff([...from, "-af", `silencedetect=n=${(level.I - 20).toFixed(1)}dB:d=0.5`, "-f", "null", "-"], { signal });
      for (const m of log.matchAll(/silence_duration:\s*([\d.]+)/g)) quiet += Number(m[1]);
    }
    const I = heard ? 10 * Math.log10(energy / heard) : null;
    const share = Math.min(1, quiet / total);
    const fixed = ROLES.includes(wanted[index]) ? wanted[index] : null;
    const role = fixed ?? (I === null ? "fora" : count === 1 ? "misto" : share >= VOICE_QUIET ? "voz" : "jogo");
    tracks.push({ index, loudness: I === null ? null : +I.toFixed(1), quiet: +share.toFixed(2), spread: null, role, fixed: Boolean(fixed) });
  }
  // Nothing sounded like a voice: cuts and captions still need something to listen to.
  if (count > 1 && !tracks.some((t) => SPOKEN.includes(t.role))) {
    const loudest = tracks.filter((t) => t.role !== "fora" && !t.fixed).sort((a, b) => b.loudness - a.loudness)[0];
    if (loudest) loudest.role = "misto";
  }
  // Several tracks with speech: the one with a single voice is the creator, the others are the chat.
  const open = tracks.filter((t) => t.role === "voz" && !t.fixed);
  const fixedVoice = tracks.some((t) => t.role === "voz" && t.fixed);
  if (open.length > (fixedVoice ? 0 : 1)) {
    for (const t of open) {
      const spread = await timbreSpread(file, t.index, duration, signal);
      t.spread = spread === null ? null : +spread.toFixed(2);
    }
    const mine = fixedVoice ? null : [...open].sort((a, b) => (a.spread ?? Infinity) - (b.spread ?? Infinity) || b.loudness - a.loudness)[0];
    for (const t of open) if (t !== mine) t.role = "conversa";
  }
  return tracks;
}

const describe = (tracks) =>
  tracks
    .map((t) => {
      const facts = [t.loudness === null ? null : `${t.loudness} LUFS`, t.loudness === null ? null : `${Math.round(t.quiet * 100)}% de pausas`, t.spread ? `timbre varia ${t.spread} dB entre as falas` : null].filter(Boolean);
      return `faixa ${t.index + 1}: ${ROLE_LABEL[t.role]}${t.fixed ? " (fixada por você)" : ""}${facts.length ? ` (${facts.join(", ")})` : ""}`;
    })
    .join("; ");

/** The tracks with speech, each at the same level, in one file: what the transcription listens to. */
async function speechMix(file, tracks, out, { signal, total, onProgress } = {}) {
  const spoken = tracks.filter((t) => SPOKEN.includes(t.role));
  const used = spoken.length ? spoken : tracks.filter((t) => t.role !== "fora").slice(0, 1);
  const graph = used.map((t, i) => `[0:a:${t.index}]volume=${Math.max(-20, Math.min(40, -20 - (t.loudness ?? -20))).toFixed(2)}dB[s${i}]`);
  const mix = used.length > 1 ? `${used.map((_, i) => `[s${i}]`).join("")}amix=inputs=${used.length}:normalize=0,` : "[s0]";
  await ff(["-i", file, "-vn", "-filter_complex", `${graph.join(";")};${mix}alimiter=limit=0.84:level=false,aresample=48000[out]`, "-map", "[out]", "-c:a", "flac", out], { signal, total, onProgress });
}

/** DeepFilterNet's command-line build: far better than FFmpeg at noise and room echo, when the creator installed it. */
function deepFilter(exe, input, outDir, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ["-o", outDir, input], { windowsHide: true });
    let log = "";
    const stop = () => child.kill();
    signal?.addEventListener("abort", stop);
    child.stderr.on("data", (c) => (log = (log + c).slice(-2000)));
    child.stdout.on("data", (c) => (log = (log + c).slice(-2000)));
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", stop);
      const out = path.join(outDir, path.basename(input));
      if (code === 0 && fs.existsSync(out)) resolve(out);
      else reject(new Error(`DeepFilterNet falhou (${code}): ${log.trim().split(/\r?\n/).pop() ?? ""}`));
    });
  });
}

/**
 * Writes the finished sound of `source` into `dir`: one file per track ("som-1-minha-voz.flac"...) and the
 * mix of them all in `out`.
 * options: { tracks, noise, gameLevel and chatLevel (dB against the creator's voice), clean, deepFilterExe, duration,
 *            signal, progress, log, from, length }
 */
async function mix(source, out, dir, options) {
  const { noise = 12, gameLevel = -10, chatLevel = -2, clean = true, duration, signal, progress = () => {}, log = () => {} } = options;
  const cut = options.length ? ["-ss", String(options.from ?? 0), "-t", String(options.length)] : [];
  const tracks = options.tracks.filter((t) => t.role !== "fora" && t.loudness !== null);
  if (!tracks.length) throw new Error("Não consegui medir o volume: o arquivo parece não ter som.");
  const voice = tracks.filter((t) => t.role === "voz");

  // Room echo and heavy noise: only on the creator's own microphone.
  const inputs = new Map();
  if (clean && options.deepFilterExe && voice.length === 1 && !cut.length) {
    progress(0.02, "Tirando ruído e eco (DeepFilterNet)");
    const wav = path.join(dir, "voz-48k.wav");
    const outDir = path.join(dir, "deepfilter");
    try {
      await ff(["-i", source, "-vn", "-map", `0:a:${voice[0].index}`, "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", wav], { signal });
      fs.mkdirSync(outDir, { recursive: true });
      inputs.set(voice[0].index, await deepFilter(options.deepFilterExe, wav, outDir, signal));
      log("info", "Ruído e eco da sua voz reduzidos com o DeepFilterNet.");
    } catch (err) {
      if (signal?.aborted) throw err;
      log("warn", `${err.message} Usando a redução de ruído do FFmpeg.`);
    } finally {
      fs.rmSync(wav, { force: true });
    }
  }
  const input = (t) => (inputs.has(t.index) ? ["-i", inputs.get(t.index), "-map", "0:a:0"] : [...cut, "-i", source, "-map", `0:a:${t.index}`]);
  const pre = (t) => Math.max(-20, Math.min(40, -18 - t.loudness));
  const filters = (t) => chain(t.role, pre(t), { noise, clean, deepFiltered: inputs.has(t.index) });

  // 1. How loud each track is after its own treatment, over the whole recording.
  const span = options.length ?? duration;
  let done = 0;
  const measured = await Promise.all(
    tracks.map(async (t) => {
      const level = loudness(await ff([...input(t), "-vn", "-af", [...filters(t), "ebur128"].join(","), "-f", "null", "-"], { signal }));
      progress(0.08 + 0.27 * (++done / tracks.length), "Medindo o volume de cada faixa");
      return level;
    }),
  );

  // 2. Each track treated and at its place, in its own file; the mix of them is measured on the way.
  const leads = tracks.some((t) => t.role !== "jogo");
  const args = [];
  const graph = [];
  const stems = [];
  const sources = [];
  tracks.forEach((t, i) => {
    if (!measured[i]) return;
    const target = VOICE_LEVEL + (t.role === "jogo" && leads ? gameLevel : t.role === "conversa" ? chatLevel : 0);
    const gain = target - measured[i].I;
    const file = inputs.get(t.index) ?? source;
    let at = sources.indexOf(file);
    if (at < 0) {
      at = sources.push(file) - 1;
      args.push(...(file === source ? cut : []), "-i", file);
    }
    const n = stems.length;
    graph.push(`[${at}:a:${file === source ? t.index : 0}]${[...filters(t), `volume=${gain.toFixed(2)}dB`, "alimiter=limit=0.7:level=false", "aresample=48000", "aformat=channel_layouts=stereo"].join(",")},asplit[w${n}][m${n}]`);
    stems.push({ track: t, gain: gain + pre(t), rough: path.join(dir, `som-${t.index + 1}-bruto.flac`), path: path.join(dir, `som-${t.index + 1}-${STEM_NAME[t.role] ?? "som"}.flac`) });
  });
  if (!stems.length) throw new Error("Não consegui medir o volume: o arquivo parece não ter som.");
  const joined = stems.length > 1 ? `${stems.map((_, i) => `[m${i}]`).join("")}amix=inputs=${stems.length}:normalize=0,` : "[m0]";
  const together = loudness(
    await ff([...args, "-vn", "-filter_complex", `${graph.join(";")};${joined}ebur128=peak=true[mix]`, ...stems.flatMap((s, i) => ["-map", `[w${i}]`, "-c:a", "flac", s.rough]), "-map", "[mix]", "-f", "null", "-"], {
      signal,
      total: span,
      onProgress: (p) => progress(0.35 + 0.4 * p, "Limpando cada faixa"),
    }),
  );
  if (inputs.size) fs.rmSync(path.join(dir, "deepfilter"), { recursive: true, force: true });
  if (!together) throw new Error("Não consegui medir o volume da mistura.");

  // 3. One last gain, the same for every track, so that together they reach the target. Loud moments of
  // several tracks can still pile up: the export's own limiter holds those, as the one on the mix does here.
  const trim = TARGET.I - together.I;
  for (const stale of fs.readdirSync(dir)) if (/^som-\d+-.*\.flac$/.test(stale) && !stems.some((s) => path.join(dir, stale) === s.rough)) fs.rmSync(path.join(dir, stale), { force: true });
  const last = stems.map((_, i) => `[${i}:a]volume=${trim.toFixed(2)}dB,asplit[w${i}][m${i}]`);
  const final = loudness(
    await ff([...stems.flatMap((s) => ["-i", s.rough]), "-filter_complex", `${last.join(";")};${joined}alimiter=limit=${(10 ** (TARGET.TP / 20)).toFixed(3)}:level=false,ebur128=peak=true[mix]`, ...stems.flatMap((s, i) => ["-map", `[w${i}]`, "-c:a", "flac", s.path]), "-map", "[mix]", "-c:a", "flac", out], {
      signal,
      total: span,
      onProgress: (p) => progress(0.75 + 0.24 * p, "Acertando o volume final"),
    }),
  );
  for (const s of stems) fs.rmSync(s.rough, { force: true });
  return {
    stems: stems.map((s) => ({ index: s.track.index, role: s.track.role, path: s.path, gain: +(s.gain + trim).toFixed(1) })),
    lufs: final?.I ?? null,
    peak: final?.peak ?? null,
    deepFilter: inputs.size > 0,
  };
}

async function run(ctx) {
  const { video, dir, settings } = ctx;
  const cfg = settings.audio;
  const { duration } = video.data;
  let tracks = video.data.tracks ?? [{ index: 0, role: "misto", loudness: -23, quiet: 0 }];
  // One track only: the preset says whether it is a voice alone or a voice over the game.
  if (tracks.length === 1) {
    const preset = cfg.preset === "auto" ? (ctx.cut?.mode === "gameplay" ? "misto" : "voz") : cfg.preset;
    tracks = [{ ...tracks[0], role: preset === "voz" ? "voz" : "misto" }];
    ctx.log("decision", `Preset "${PRESETS[preset].label}"${cfg.preset === "auto" ? ` escolhido porque há fala em ${Math.round((ctx.cut?.speechRatio ?? 1) * 100)}% do tempo` : ""}.`);
  } else ctx.log("decision", `Faixas de som: ${describe(tracks)}. Cada uma é tratada sozinha e fica na sua própria faixa do projeto.`);
  if (cfg.deepFilter && !ctx.deepFilterExe && tracks.some((t) => t.role === "voz")) ctx.log("info", "Ruído da sua voz reduzido com o FFmpeg. Eco e reverberação de sala precisam do DeepFilterNet, que não está instalado (Configurações → Áudio).");

  const out = path.join(dir, "audio-limpo.flac");
  const level = (value, fallback) => (Number.isFinite(Number(value)) ? Math.max(-30, Math.min(6, Number(value))) : fallback);
  const gameLevel = level(cfg.gameLevel, -10);
  const chatLevel = level(cfg.chatLevel, -2);
  const result = await mix(video.source_path, out, dir, {
    tracks,
    noise: cfg.noise,
    gameLevel,
    chatLevel,
    clean: cfg.preset !== "leve",
    deepFilterExe: cfg.deepFilter ? ctx.deepFilterExe : null,
    duration,
    signal: ctx.signal,
    progress: ctx.progress,
    log: ctx.log,
  });
  const moves = result.stems.map((s) => `faixa ${s.index + 1} (${ROLE_LABEL[s.role]}) ${s.gain >= 0 ? "+" : ""}${s.gain.toFixed(1)} dB`).join(", ");
  const places = [tracks.some((t) => t.role === "conversa") ? `conversa ${chatLevel} dB` : null, tracks.some((t) => t.role === "jogo") ? `jogo ${gameLevel} dB` : null].filter(Boolean);
  ctx.log("decision", `Volume final: ${result.lufs?.toFixed(1) ?? "?"} LUFS (alvo ${TARGET.I}), pico em ${result.peak?.toFixed(1) ?? "?"} dB. Ganhos: ${moves}.${places.length ? ` Em relação à sua voz: ${places.join(", ")}.` : ""}`);
  return { path: out, stems: result.stems, deepFilter: result.deepFilter, lufsAfter: result.lufs, truePeak: result.peak, gameLevel, chatLevel };
}

module.exports = { run, analyse, speechMix, mix, describe, timbreSpread, PRESETS, TARGET, ROLES, ROLE_LABEL };

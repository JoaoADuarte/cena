/**
 * The studio: a queue of videos and scripts worked on by agents, with the creator approving at two gates
 * (the script before recording, the video before anything can be published).
 * Everything is kept in SQLite, so work survives a restart and any stage can be paused or redone.
 */
const { app, BrowserWindow, Notification, Tray, Menu, dialog, shell } = require("electron");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const { AsyncLocalStorage } = require("node:async_hooks");
const path = require("node:path");
const { openDb } = require("./db.cjs");
const { createLlm } = require("./llm.cjs");
const { createApprovals } = require("./approval.cjs");
const { createWatcher, VIDEO_EXT } = require("./watcher.cjs");
const { ff } = require("./ffmpeg.cjs");
const { FFPROBE } = require("../media.cjs");
const { createAi } = require("../ai.cjs");
const research = require("./agents/research.cjs");
const script = require("./agents/script.cjs");
const cut = require("./agents/cut.cjs");
const audio = require("./agents/audio.cjs");
const review = require("./agents/review.cjs");
const edit = require("./agents/edit.cjs");
const thumbnail = require("./agents/thumbnail.cjs");
const thumbnailArt = require("./agents/thumbnail-art.cjs");
const metadata = require("./agents/metadata.cjs");
const shorts = require("./agents/shorts.cjs");
const director = require("./agents/director.cjs");
const trends = require("./agents/trends.cjs");
const visualCheck = require("./visual.cjs");
const growth = require("./agents/growth.cjs");
const { flatten } = require("./flatten.cjs");
const { createYouTube } = require("./youtube.cjs");
const { createPublisher } = require("./publish.cjs");

/** Video stages, in order, with the agent that does each and what it competes for. */
const STAGES = [
  { name: "ingest", label: "Ingestão", agent: "ingest", resource: "ffmpeg" },
  { name: "cut", label: "Corte", agent: "cut", resource: "asr" },
  { name: "audio", label: "Áudio", agent: "audio", resource: "ffmpeg" },
  // Only when the request asks for several videos from one recording; otherwise it passes in a moment.
  { name: "split", label: "Divisão", agent: "director", resource: "llm" },
  { name: "edit", label: "Edição", agent: "edit", resource: "llm" },
  { name: "metadata", label: "Metadados", agent: "metadata", resource: "llm" },
  // The person cut-out runs in the same AI process as the transcription: one at a time.
  { name: "thumbnail", label: "Thumbnail", agent: "thumbnail", resource: "asr" },
  { name: "assemble", label: "Montagem", agent: "assemble", resource: "render" },
];
/** What has to run again when a stage is redone: only what uses its result. */
const REDO = {
  ingest: ["ingest", "cut", "audio", "split", "edit", "metadata", "thumbnail", "assemble"],
  cut: ["cut", "audio", "split", "edit", "metadata", "thumbnail", "assemble"],
  split: ["split", "edit", "metadata", "thumbnail", "assemble"],
  metadata: ["metadata"],
  audio: ["audio", "assemble"],
  edit: ["edit", "assemble"],
  thumbnail: ["thumbnail"],
  assemble: ["assemble"],
};
/** How many of each kind of work at once, for "Vídeos ao mesmo tempo" (1 to 3). */
const limitsFor = (n) => ({ ffmpeg: n + 1, asr: n, render: n, llm: n + 1 });
const MAX_PARALLEL = 3;
/**
 * Agents the creator can leave out of a video. Without the Cut agent the recording is still transcribed (the other
 * agents read it), but nothing is cut and no tokens are spent there. Without the Assembly the creator's own project is
 * rendered as it is (sent from the editor) or the project is only built, for them to render in the editor.
 */
const CHOOSABLE = ["cut", "audio", "edit", "metadata", "thumbnail", "assemble"];
const chosen = (video, name) => {
  const list = video?.data?.agents;
  if (!Array.isArray(list) || !CHOOSABLE.includes(name)) return true;
  // The creator's own project is rendered as it is: the agents' edit and sound would go nowhere.
  if ((name === "edit" || name === "audio") && video.data.fromEditor && !list.includes("assemble")) return false;
  return list.includes(name);
};
const AGENTS = [
  { id: "director", label: "Direção" },
  { id: "research", label: "Pesquisa" },
  { id: "script", label: "Roteiro" },
  { id: "ingest", label: "Ingestão" },
  { id: "cut", label: "Corte" },
  { id: "audio", label: "Áudio" },
  { id: "edit", label: "Edição" },
  { id: "metadata", label: "Metadados" },
  { id: "thumbnail", label: "Thumbnail" },
  { id: "assemble", label: "Montagem" },
  { id: "shorts", label: "Shorts" },
  { id: "review", label: "Correções" },
  { id: "publish", label: "Publicação" },
];

const DEFAULTS = {
  channel: { niche: "" },
  models: { research: null, script: null, cut: null, edit: null, metadata: null, thumbnail: null, review: null, shorts: null },
  cut: { style: "auto", quality: "accurate", language: "pt", minPause: 0.7, longQuiet: 20, removeStill: true },
  // "tracks": what each sound track of the recordings is ("auto", "voz", "conversa", "jogo", "fora").
  // "gameLevel" and "chatLevel": dB against the creator's voice.
  audio: { preset: "auto", noise: 12, deepFilter: true, tracks: [], gameLevel: -10, chatLevel: -2 },
  edit: {
    intensity: "media",
    captions: true,
    captionWords: 4,
    captionPop: true,
    zooms: true,
    texts: true,
    transitions: true,
    transition: "fade",
    music: true,
    musicVolume: 0.12,
    musicQuery: "",
    colour: true,
    broll: false,
    stabilize: false,
    font: "Arial Black",
    textColour: "#ffd400",
  },
  thumbnail: { count: 4 },
  // How a Short is framed unless the creator picks another way for that one.
  // auto: when a video is ready, the Shorts agent makes its best moments (score ≥ minScore, up to `count`) and,
  // with `stories`, one Story to post on Instagram/WhatsApp/TikTok. All of them wait for the creator's approval.
  shorts: { frame: "square", captions: true, auto: true, count: 3, minScore: 70, stories: true },
  // "auto" sends an approved video right away; off, each one waits for a click on "Enviar ao YouTube".
  publish: { privacy: "public", auto: false },
  // "direct": untouched stretches skip the compositor (off only to compare the two ways of rendering).
  render: { gpu: true, quality: "recommended", direct: true },
  voice: { learn: true },
  // What every new recording starts with: how the creator wants it edited and where the flow stops for them.
  flow: { brief: "", stops: [], agents: null },
  watch: { enabled: false, folder: "", ignore: [] },
  notify: true,
  paused: false,
  agentsPaused: {},
  // Videos worked on at the same time: each has its own assembly desk (a hidden Cena), transcription and render.
  parallel: 2,
};

/** This video's editing options. A game already has its own music: background music only when the creator asks for it. */
const editOptions = (cfg, video) => {
  const mine = video.data.overrides?.edit ?? {};
  const opts = merge(cfg, mine);
  if ((video.data.tracks ?? []).some((t) => t.role === "jogo") && mine.music !== true) opts.music = false;
  return opts;
};

const merge = (base, patch) => {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) out[key] = value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object" ? merge(base[key], value) : value;
  return out;
};

function createStudio({ agent, preload, loadWindow, openEditor, smoke = false }) {
  const root = path.join(app.getPath("userData"), "estudio");
  const db = openDb(path.join(root, "estudio.db"));
  db.resetRunning();
  // Videos queued by an older version get the stages that exist now. A video already rendered is not redone for them.
  for (const video of db.videos()) {
    const have = new Set(db.stages(video.id).map((s) => s.name));
    for (const stage of STAGES) if (!have.has(stage.name)) db.addStage(video.id, stage.name, video.data.finalPath ? "skipped" : "pending");
  }
  /** A video's stages in the order they run, whatever order they were stored in. */
  const stagesOf = (videoId) => {
    const rows = db.stages(videoId);
    return STAGES.map((s) => rows.find((r) => r.name === s.name)).filter(Boolean);
  };
  const finished = (videoId) => stagesOf(videoId).every((s) => s.status === "done" || s.status === "skipped");
  const llm = createLlm({ workspace: path.join(root, "agentes") });
  const ai = createAi("Cena Estúdio IA");
  const approvals = createApprovals(db);
  const deepFilterExe = path.join(root, "ferramentas", "deep-filter.exe");

  let studioWindow = null;
  /** The hidden Cenas ("mesas de montagem"), one per video being assembled at the same time. */
  const desks = [];
  const lease = new AsyncLocalStorage();
  let tray = null;
  let quitting = false;
  /** key → { agent, videoId?, scriptId?, controller, resource } */
  const running = new Map();
  const lastError = new Map();

  const settings = () => merge(DEFAULTS, db.setting("settings", {}));
  const limits = () => limitsFor(Math.max(1, Math.min(MAX_PARALLEL, Math.round(Number(settings().parallel) || 1))));
  const voice = () => db.setting("voiceProfile", { text: "", wpm: 0, samples: 0 });
  /** Trends: the last searches, the styles studied from them and the one the editor and the agents follow. */
  const trendsData = () => ({ searches: [], styles: [], active: null, ...db.setting("trends", {}) });
  const saveTrends = (patch) => db.setSetting("trends", { ...trendsData(), ...patch });
  const activeStyle = () => {
    const t = trendsData();
    return t.styles.find((s) => s.id === t.active) ?? null;
  };
  const videoDir = (id) => {
    const dir = path.join(root, "videos", String(id));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const youtube = createYouTube({ db, cacheFile: path.join(root, "youtube-cache.json") });
  const publisher = createPublisher({ db, approvals, youtube, running, settings, changed, notify });
  // An approval that falls takes its upload with it, wherever in this file it falls.
  const revokeApproval = approvals.revoke;
  approvals.revoke = (videoId) => {
    publisher.cancel(videoId);
    return revokeApproval(videoId);
  };
  /** The description as it will be sent, with chapters where they are in the video as it is cut now. */
  const composed = (video, changes = {}, { cuts = video.data.cuts ?? [], credits = video.data.credits ?? [] } = {}) => metadata.compose({ ...(video.data.metadata ?? {}), ...changes }, { cuts, credits });

  // --- Telling the panel ---------------------------------------------------------------------
  let changeTimer = null;
  function changed() {
    if (changeTimer) return;
    changeTimer = setTimeout(() => {
      changeTimer = null;
      if (studioWindow && !studioWindow.isDestroyed()) studioWindow.webContents.send("studio:changed");
    }, 120);
  }
  function notify(title, body) {
    if (!settings().notify || smoke || !Notification.isSupported()) return;
    const note = new Notification({ title, body });
    note.on("click", () => openStudio());
    note.show();
  }

  // --- Machine load ---------------------------------------------------------------------------
  const system = { cpu: 0, gpu: null };
  let cpuBefore = os.cpus();
  const usageTimer = setInterval(() => {
    const now = os.cpus();
    let idle = 0;
    let total = 0;
    now.forEach((cpu, i) => {
      const prev = cpuBefore[i]?.times ?? cpu.times;
      for (const key of Object.keys(cpu.times)) total += cpu.times[key] - prev[key];
      idle += cpu.times.idle - prev.idle;
    });
    cpuBefore = now;
    system.cpu = total > 0 ? Math.round((1 - idle / total) * 100) : 0;
    if (!studioWindow || studioWindow.isDestroyed() || !studioWindow.isVisible()) return;
    execFile("nvidia-smi", ["--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"], { windowsHide: true, timeout: 2500 }, (err, stdout) => {
      const [name, load, used, totalMem] = String(stdout ?? "").split(/\r?\n/)[0].split(",").map((s) => s.trim());
      system.gpu = err || !name ? null : { name, load: Number(load), memoryUsed: Number(used), memoryTotal: Number(totalMem) };
      studioWindow?.webContents.send("studio:system", system);
    });
  }, 3000);

  // --- Worker window: a hidden Cena that builds and exports projects ----------------------------
  function worker(desk) {
    if (desk.win && !desk.win.isDestroyed() && desk.ready) return desk.ready;
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 720,
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false, additionalArguments: ["--studio-worker"] },
    });
    desk.win = win;
    loadWindow(win, "trabalho");
    desk.ready = (async () => {
      for (let i = 0; i < 80; i++) {
        try {
          await agent.callToolIn(win, "get_project", {}, 3000);
          return win;
        } catch {
          await new Promise((r) => setTimeout(r, 400));
        }
      }
      throw new Error("A janela de trabalho do Estúdio não abriu.");
    })();
    desk.ready.catch(() => (desk.ready = null));
    win.on("closed", () => {
      if (desk.win === win) {
        desk.win = null;
        desk.ready = null;
      }
    });
    return desk.ready;
  }
  /** Runs `fn` at a free desk of its own: every editor tool called inside it goes to that hidden Cena. */
  async function withWorker(fn) {
    if (lease.getStore()) return fn();
    let desk = desks.find((d) => !d.busy);
    if (!desk) desks.push((desk = { win: null, ready: null, busy: false }));
    desk.busy = true;
    try {
      return await lease.run(desk, fn);
    } finally {
      desk.busy = false;
      // Desks beyond the number now allowed are closed, so the memory comes back when it is lowered.
      for (const d of desks.filter((x) => !x.busy).slice(limits().render)) {
        desks.splice(desks.indexOf(d), 1);
        if (d.win && !d.win.isDestroyed()) d.win.destroy();
      }
    }
  }
  const isDesk = (win) => desks.some((d) => d.win === win);
  const tool = async (name, args = {}, timeout) => {
    const desk = lease.getStore();
    if (!desk) throw new Error("Ferramenta do editor chamada fora de uma mesa de montagem.");
    return agent.callToolIn(await worker(desk), name, args, timeout);
  };

  // --- Context handed to agents ----------------------------------------------------------------
  function context({ videoId = null, scriptId = null, agentId, signal, onProgress = () => {} }) {
    const log = (level, message) => {
      db.log({ videoId, scriptId, agent: agentId, level, message });
      changed();
    };
    return {
      db,
      workspace: path.join(root, "agentes"),
      // Every call says what it spent, so the creator sees where the tokens of their plan go.
      llm: {
        ...llm,
        ask: async (options) => {
          const answer = await llm.ask(options);
          const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)} mil` : String(n));
          if (answer.usage) log("info", `Claude (${answer.usage.model}): ${k(answer.usage.input)} tokens lidos, ${k(answer.usage.output)} escritos.`);
          return answer;
        },
      },
      youtube,
      signal,
      settings: settings(),
      voice: voice(),
      style: trends.stylePrompt(activeStyle()),
      deepFilterExe: fs.existsSync(deepFilterExe) ? deepFilterExe : null,
      // What the creator asked for this video, in their words. Each agent takes from it what concerns its job.
      brief: videoId ? String(db.video(videoId)?.data.brief?.text ?? "").trim() : "",
      log,
      progress: onProgress,
    };
  }

  // --- Video stages -----------------------------------------------------------------------------
  function probeStreams(file) {
    return new Promise((resolve, reject) => {
      execFile(FFPROBE, ["-v", "error", "-show_entries", "stream=index,codec_type,width,height,r_frame_rate:format=duration", "-of", "json", file], { windowsHide: true, maxBuffer: 1e7 }, (err, stdout) => {
        if (err) return reject(new Error("Não consegui ler este arquivo de vídeo."));
        resolve(JSON.parse(stdout));
      });
    });
  }

  const HANDLERS = {
    async ingest(ctx, video) {
      // A project in the editor's order: its recording is made first, once.
      const order = video.data.flatten;
      if (order && !(order.done && fs.existsSync(video.source_path))) {
        const missing = order.segments.map((s) => s.path).find((p) => !fs.existsSync(p));
        if (missing) throw new Error(`A gravação não está mais no lugar: ${missing}`);
        const started = Date.now();
        const made = await flatten(order.segments, video.source_path, { width: order.width, height: order.height, fps: order.fps, signal: ctx.signal, progress: (p, m) => ctx.progress(0.9 * p, m) });
        db.updateVideo(video.id, { data: { flatten: { ...order, done: true } } });
        ctx.log("info", `Gravação na ordem do editor criada: ${cut.clock(made.duration)}, ${order.segments.length} trechos, ${made.tracks} faixa(s) de som separadas, ${(made.bytes / 1e9).toFixed(1)} GB, em ${cut.clock((Date.now() - started) / 1000)}. Ela fica na pasta do vídeo e sai junto quando o vídeo é apagado; as suas gravações não foram mexidas.`);
      }
      if (!fs.existsSync(video.source_path)) throw new Error("O arquivo original não está mais no lugar.");
      const info = await probeStreams(video.source_path);
      const picture = info.streams.find((s) => s.codec_type === "video");
      const sound = info.streams.filter((s) => s.codec_type === "audio");
      const duration = Number(info.format?.duration ?? 0);
      if (!picture || !duration) throw new Error("Este arquivo não tem vídeo que eu consiga ler.");
      if (!sound.length) throw new Error("Este vídeo não tem som; corte e áudio precisam dele.");
      const dir = videoDir(video.id);
      const audioPath = path.join(dir, "audio-original.flac");
      // Which track is a voice and which is the game is heard, not assumed: OBS setups differ.
      ctx.progress(0.02, "Ouvindo as faixas de som");
      const tracks = await audio.analyse(video.source_path, sound.length, duration, { signal: ctx.signal, wanted: ctx.settings.audio.tracks ?? [] });
      ctx.progress(0.1, "Separando as vozes");
      await audio.speechMix(video.source_path, tracks, audioPath, { signal: ctx.signal, total: duration, onProgress: (p) => ctx.progress(0.1 + 0.8 * p, "Separando as vozes") });
      const thumb = path.join(dir, "capa.jpg");
      await ff(["-ss", String(Math.min(duration * 0.2, 30)), "-i", video.source_path, "-frames:v", "1", "-vf", "scale=480:-2", thumb], { signal: ctx.signal }).catch(() => {});
      const [num, den] = String(picture.r_frame_rate ?? "30/1").split("/").map(Number);
      const data = { duration, width: picture.width, height: picture.height, fps: den ? Math.round((num / den) * 100) / 100 : 30, audioStreams: sound.length, tracks, audioPath, thumb: fs.existsSync(thumb) ? thumb : null };
      db.updateVideo(video.id, { data });
      if (video.data.editorKept) {
        const fixed = gapsOf(video.data.editorKept, duration).map((g) => ({ id: 0, ...g, kind: "manual", reason: "Cortado por você no editor", enabled: true }));
        db.updateVideo(video.id, { data: { fixedCuts: fixed, cuts: normalizeCuts(fixed, duration) } });
        if (fixed.length) ctx.log("info", `Do seu projeto no editor vieram ${fixed.length} cortes, que tiram ${cut.clock(fixed.reduce((sum, c) => sum + c.end - c.start, 0))}.`);
      }
      ctx.log("info", `Vídeo de ${cut.clock(duration)}, ${data.width}×${data.height} a ${data.fps} fps, ${sound.length} faixa(s) de som.`);
      if (sound.length > 1) ctx.log("decision", `Faixas de som: ${audio.describe(tracks)}. Se alguma estiver errada, corrija em Configurações → Áudio e refaça a Ingestão.`);
      await readBrief(video.id, ctx.signal);
      return data;
    },

    async cut(ctx, video) {
      const linked = video.script_id ? db.script(video.script_id) : null;
      const result = await cut.run({
        ...ctx,
        settings: { ...ctx.settings, cut: { ...ctx.settings.cut, ...(video.data.overrides?.cut ?? {}) } },
        video,
        light: !chosen(video, "cut"),
        dir: videoDir(video.id),
        scriptText: linked?.content ? script.teleprompterText(linked.content, linked.content.hook) : null,
        transcribe: (params, onProgress) => {
          const stop = () => ai.cancel();
          ctx.signal.addEventListener("abort", stop);
          return ai.run("transcribeFile", params, onProgress).finally(() => ctx.signal.removeEventListener("abort", stop));
        },
      });
      if (result.voice) {
        const before = voice();
        db.setSetting("voiceProfile", { ...result.voice, samples: (before.samples ?? 0) + 1, updated: Date.now() });
        ctx.log("info", `Perfil de voz do canal atualizado com esta gravação (${result.voice.wpm} palavras por minuto).`);
      }
      // Moments the creator asked for, changed or already turned into a Short stay; only untouched suggestions are replaced.
      const kept = (video.data.shorts ?? []).filter((s) => s.source === "prompt" || s.edited || shortRow(video.id, s.id));
      let lastId = Math.max(0, ...kept.map((s) => s.id));
      const fresh = result.shorts.filter((n) => !kept.some((o) => Math.abs(o.start - n.start) < 1 && Math.abs(o.end - n.end) < 1)).map((s) => ({ ...s, id: ++lastId }));
      result.shorts = [...kept, ...fresh].filter((s) => !video.data.partOf || (s.start >= video.data.partOf.start && s.end <= video.data.partOf.end));
      // Cuts made in the editor and the bounds of a part are the creator's: a new cut list never loses them.
      if (video.data.fixedCuts?.length) result.cuts = normalizeCuts([...result.cuts, ...video.data.fixedCuts], video.data.duration);
      if (!chosen(video, "cut")) ctx.log("info", "Você não escolheu o agente de Corte: a etapa só transcreveu a fala, que os Metadados e a Thumbnail usam. Nada foi cortado; o que ele cortaria ficou como sugestão desligada.");
      db.updateVideo(video.id, { data: { cuts: result.cuts, shorts: result.shorts, summary: result.summary, missing: result.missing, action: result.action, dirty: false } });
      return { ...result, cuts: result.cuts.length, voice: undefined, action: undefined };
    },

    async audio(ctx, video) {
      const overrides = video.data.overrides?.audio ?? {};
      const result = await audio.run({ ...ctx, settings: { ...ctx.settings, audio: { ...ctx.settings.audio, ...overrides } }, video, dir: videoDir(video.id), cut: db.stage(video.id, "cut")?.result });
      db.updateVideo(video.id, { data: { cleanAudioPath: result.path, stems: result.stems } });
      return result;
    },

    /** Several videos from one recording: proposes where each starts and ends. The flow always waits for the creator here. */
    async split(ctx, video) {
      const want = video.data.brief?.split;
      if (!want || video.data.partOf) return { parts: 0 };
      if (!llm.available()) throw new Error("Dividir a gravação em vários vídeos precisa do Claude Code.");
      const out = await director.splitParts(ctx, { video, dir: videoDir(video.id), text: video.data.brief.text, want, workspace: path.join(root, "agentes"), ff });
      db.updateVideo(video.id, { data: { parts: out.parts, partsReply: out.reply } });
      ctx.log("decision", `${out.reply} Proposta: ${out.parts.map((p) => `${p.title} (${cut.clock(p.start)}–${cut.clock(p.end)})`).join("; ")}. Confira na aba Cortes e clique em "Criar os vídeos".`);
      return { parts: out.parts.length };
    },

    /** Plans what goes on top of the cut video. Nothing is rendered here: the assembly applies the plan. */
    async edit(ctx, video) {
      const cfg = editOptions(ctx.settings.edit, video);
      const plan = await edit.run({ ...ctx, settings: { ...ctx.settings, edit: cfg }, video, dir: videoDir(video.id) });
      // What the creator asked for by hand in a review survives a new plan.
      const kept = (video.data.edit?.texts ?? []).filter((t) => t.manual);
      plan.texts = [...plan.texts, ...kept.map((t, i) => ({ ...t, id: 9000 + i }))].sort((a, b) => a.time - b.time);
      db.updateVideo(video.id, { data: { edit: plan } });
      return { zooms: plan.zooms.length, texts: plan.texts.length, sections: plan.sections.length, broll: plan.broll.length, music: plan.music?.query ?? null, colour: Boolean(plan.colour), stabilized: Boolean(plan.stablePath) };
    },

    /** Title options, description, tags and chapters. Text only; the creator edits and approves it in the review. */
    async metadata(ctx, video) {
      const linked = video.script_id ? db.script(video.script_id) : null;
      const meta = await metadata.run({ ...ctx, siblings: seriesOf(video).filter((v) => v.id !== video.id).map((v) => v.data.metadata?.title).filter(Boolean), video, dir: videoDir(video.id), research: linked?.research ?? null, scriptTitles: linked?.content?.titles ?? [] });
      // What the creator wrote by hand stays; only the suggestions around it are renewed.
      const before = video.data.metadata;
      if (before?.manual) Object.assign(meta, { title: before.title, body: before.body, tags: before.tags, hashtags: before.hashtags, category: before.category, useChapters: before.useChapters, manual: true });
      const clean = composed(video, meta);
      db.updateVideo(video.id, { data: { metadata: clean } });
      return { title: clean.title, titles: clean.titles.length, tags: clean.tags.length, chapters: clean.chapterLines.length };
    },

    /** A thumbnail that fails never holds the video back: the creator can ask for new ones in the review. */
    async thumbnail(ctx, video) {
      try {
        const result = await thumbnail.run({
          ...ctx,
          siblings: seriesOf(video)
            .filter((v) => v.id !== video.id)
            .flatMap((v) => (v.data.thumbnails ?? []).map((t) => t.text))
            .filter(Boolean)
            .slice(0, 24),
          video,
          dir: videoDir(video.id),
          // Images the creator may name in the request ("use a imagem x da pasta"): the recording's folder and the watched folder.
          assetFolders: [...new Set([path.dirname(video.source_path), settings().watch.folder].filter(Boolean))],
          removeBackground: (file, outPath) => {
            const stop = () => ai.cancel();
            ctx.signal.addEventListener("abort", stop);
            return ai.run("removeBackground", { kind: "image", path: file, outPath }).finally(() => ctx.signal.removeEventListener("abort", stop));
          },
        });
        db.updateVideo(video.id, { data: { thumbnails: result.thumbnails, thumbnail: result.thumbnail, thumbnailRequest: null, ...(result.facecam !== undefined ? { facecam: result.facecam } : {}) } });
        return { count: result.thumbnails.length };
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        ctx.log("warn", `Thumbnails não geradas (${err.message}). O vídeo segue sem elas; peça de novo na revisão.`);
        db.updateVideo(video.id, { data: { thumbnailRequest: null } });
        return { count: 0, error: err.message };
      }
    },

    /** Builds a normal Cena project (so it can be opened and changed by hand) and renders it. */
    assemble: (ctx, video) => withWorker(async () => {
      const dir = videoDir(video.id);
      // Exported in the editor by the creator: that file is the final video, as it is.
      if (video.data.exported) {
        if (!fs.existsSync(video.data.exported)) throw new Error("O vídeo exportado não está mais no lugar.");
        const info = await probeStreams(video.data.exported);
        const finalDuration = Number(info.format?.duration ?? 0);
        db.updateVideo(video.id, { data: { finalPath: video.data.exported, finalDuration, dirty: false, renderedAt: Date.now() } });
        ctx.log("info", "Nada para renderizar: o vídeo que você exportou é o vídeo final.");
        const now = db.video(video.id);
        if (now.data.metadata) db.updateVideo(video.id, { data: { metadata: composed(now) } });
        return { finalPath: video.data.exported, finalDuration, mine: true };
      }
      // The creator's own project, rendered as it is: sent from the editor, or changed by them after the agents built it.
      const mine = video.data.renderMine ?? (!chosen(video, "assemble") ? (video.data.fromEditor?.copy ?? null) : null);
      if (mine) {
        if (!fs.existsSync(mine)) throw new Error("O projeto do editor não foi encontrado.");
        ctx.progress(0.02, "Abrindo o seu projeto");
        await tool("new_project", { discardChanges: true });
        await tool("open_project", { path: mine }, 10 * 60_000);
        ctx.log("info", "Renderizando o seu projeto como ele está no editor.");
        return renderOpen(ctx, video, { projectPath: mine });
      }
      const { cleanAudioPath, cuts = [], duration } = video.data;
      const enabled = cuts.filter((c) => c.enabled);
      approvals.revoke(video.id);
      ctx.progress(0.02, "Montando o projeto no Cena");
      await tool("new_project", { discardChanges: true });
      const stable = video.data.edit?.stablePath;
      const opts = editOptions(ctx.settings.edit, video);
      const picturePath = opts.stabilize && stable && fs.existsSync(stable) ? stable : video.source_path;
      // Each treated track goes on its own track of the project, as the editor does with a recording from OBS:
      // the creator's voice, the chat and the game can still be changed one by one.
      const treated = chosen(video, "audio");
      const stems = treated ? (video.data.stems ?? []).filter((s) => fs.existsSync(s.path)) : [];
      const soundPaths = stems.length ? stems.map((s) => s.path) : treated && cleanAudioPath && fs.existsSync(cleanAudioPath) ? [cleanAudioPath] : [];
      const imported = await tool("import_media", { paths: [picturePath, ...soundPaths] }, 30 * 60_000);
      if (imported.failed?.length) throw new Error(`O Cena não conseguiu importar: ${imported.failed.join(", ")}`);
      const [picture, ...sounds] = imported.materials;
      const soundIds = new Set(sounds.map((m) => m.id));
      const clip = await tool("add_clip", { materialId: picture.id, start: 0 });
      // The original sound gives way to the cleaned one, which sits on its own track in sync.
      const project = await tool("get_project");
      const original = project.tracks.flatMap((t) => t.clips).filter((c) => c.id !== clip.id && !soundIds.has(c.materialId));
      // The Audio agent's files replace the recording's sound: every original track goes silent.
      // Without the Audio agent the recording keeps its own sound.
      if (sounds.length) await tool("update_clip", { clipIds: [clip.id, ...original.map((c) => c.id)], volume: 0 });
      for (const sound of sounds) await tool("add_clip", { materialId: sound.id, start: 0 });
      if (enabled.length) await tool("remove_ranges", { ranges: enabled.map((c) => ({ start: c.start, end: c.end })) });
      ctx.progress(0.04, "Aplicando a edição");
      const applied = chosen(video, "edit") ? await edit.apply({ tool, ctx, video, dir, pictureId: picture.id, opts }) : { done: {}, credits: [] };
      await tool("update_project", { name: video.title });
      const projectPath = path.join(dir, `${video.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim() || "video"}.cena`);
      await tool("save_project", { path: projectPath, overwrite: true });
      const assembled = await tool("get_project");
      ctx.log("info", `Projeto montado: ${enabled.length} cortes aplicados, ${cut.clock(duration)} → ${cut.clock(assembled.duration)}.`);
      const projectBuiltAt = fs.statSync(projectPath).mtimeMs;
      if (!chosen(video, "assemble")) {
        await tool("new_project", { discardChanges: true });
        db.updateVideo(video.id, { data: { projectPath, projectBuiltAt, finalPath: null, dirty: false, editDone: applied.done, credits: applied.credits } });
        ctx.log("info", "Projeto pronto, sem renderizar, como você pediu. Abra no editor para ajustar e exportar, ou clique em Renderizar na revisão.");
        return { projectPath, cuts: enabled.length, edit: applied.done, rendered: false };
      }
      return renderOpen(ctx, video, { projectPath, projectBuiltAt, applied, cuts: enabled.length });
    }),
  };

  /** Renders the project open in the hidden worker into the video's final file. */
  async function renderOpen(ctx, video, { projectPath, projectBuiltAt = null, applied = null, cuts: cutCount = null }) {
    {
      const dir = videoDir(video.id);
      const finalPath = path.join(dir, "final.mp4");
      ctx.progress(0.08, "Renderizando");
      const renderStart = Date.now();
      let job = await tool("export_video", { path: finalPath, format: "h264", quality: ctx.settings.render.quality, gpu: ctx.settings.render.gpu, direct: ctx.settings.render.direct !== false, normalizeLoudness: false, overwrite: true }, 5 * 60_000);
      const stop = () => job?.jobId && void tool("cancel_job", { jobId: job.jobId }).catch(() => {});
      ctx.signal.addEventListener("abort", stop);
      try {
        while (job?.status === "running") {
          const pct = Number(/(\d+)%/.exec(job.progress ?? "")?.[1] ?? 0);
          ctx.progress(0.08 + 0.9 * (pct / 100), `Renderizando ${pct}%`);
          if (ctx.signal.aborted) throw new Error("Interrompido.");
          job = await tool("get_job", { jobId: job.jobId, wait: 4 }, 60_000);
        }
      } finally {
        ctx.signal.removeEventListener("abort", stop);
      }
      if (ctx.signal.aborted) throw new Error("Interrompido.");
      if (!job?.path || !fs.existsSync(finalPath)) throw new Error("A renderização não gerou o arquivo final.");
      const info = await probeStreams(finalPath);
      const finalDuration = Number(info.format?.duration ?? 0);
      const took = (Date.now() - renderStart) / 1000;
      const share = (n) => Math.round((100 * (Number(n) || 0)) / Math.max(1, Number(job.frames) || 1));
      ctx.log("info", `Renderização: ${cut.clock(finalDuration)} de vídeo em ${cut.clock(took)} (${(finalDuration / Math.max(1, took)).toFixed(1)}x o tempo real). ${share(job.directFrames) + share(job.overlayFrames)}% dos quadros foram direto pelo FFmpeg (${share(job.overlayFrames)}% com legendas e textos por cima); o resto passou pelo compositor.`);
      db.updateVideo(video.id, {
        data: {
          finalPath,
          projectPath,
          projectBuiltAt: projectBuiltAt ?? fs.statSync(projectPath).mtimeMs,
          finalDuration,
          dirty: false,
          renderedAt: Date.now(),
          renderMine: null,
          ...(applied ? { editDone: applied.done, credits: applied.credits } : {}),
        },
      });
      await tool("new_project", { discardChanges: true }).catch(() => {});
      // The music may have changed, and with it the credits the description owes.
      const now = db.video(video.id);
      if (now.data.metadata) db.updateVideo(video.id, { data: { metadata: composed(now) } });
      return { finalPath, projectPath, finalDuration, cuts: cutCount, edit: applied?.done ?? null, mine: !applied };
    }
  }

  const used = (resource) => [...running.values()].filter((r) => r.resource === resource).length;

  async function runStage(video, stage) {
    const key = `video:${video.id}`;
    const controller = new AbortController();
    running.set(key, { agent: stage.agent, videoId: video.id, controller, resource: stage.resource, stage: stage.name });
    const before = db.stage(video.id, stage.name);
    db.updateStage(video.id, stage.name, { status: "running", progress: 0, message: null, attempt: before.attempt + 1, started_at: Date.now(), finished_at: null });
    db.updateVideo(video.id, { status: "running", error: null });
    changed();
    let lastWrite = 0;
    const ctx = context({
      videoId: video.id,
      agentId: stage.agent,
      signal: controller.signal,
      onProgress: (fraction, message) => {
        if (Date.now() - lastWrite < 400) return;
        lastWrite = Date.now();
        try {
          db.updateStage(video.id, stage.name, { progress: Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0, message: message ?? null });
          changed();
        } catch (err) {
          console.error("[estudio] progresso não gravado:", err);
        }
      },
    });
    try {
      const result = await HANDLERS[stage.name](ctx, db.video(video.id));
      db.updateStage(video.id, stage.name, { status: "done", progress: 1, message: null, result, finished_at: Date.now() });
      lastError.delete(stage.agent);
      const current = db.video(video.id);
      if (finished(video.id)) {
        db.updateVideo(video.id, { status: "review" });
        db.log({ videoId: video.id, agent: stage.agent, level: "info", message: stage.name === "assemble" ? "Vídeo pronto. Aguardando a sua aprovação." : `${stage.label} refeita. Aguardando a sua aprovação.` });
        notify("Vídeo pronto para revisão", current.title);
        autoShorts(video.id);
      } else if (current.status === "running") {
        // A stop the creator asked for: the flow waits for them here, with everything done so far kept.
        if ((current.data.brief?.stops ?? []).includes(stage.name) || (stage.name === "split" && current.data.parts?.length && !current.data.children?.length)) {
          db.updateVideo(video.id, { status: "hold", data: { hold: { after: stage.name, at: Date.now() } } });
          db.log({ videoId: video.id, agent: stage.agent, level: "decision", message: `Parado depois de "${stage.label}", como você pediu. Confira e clique em Continuar.` });
          notify("Vídeo esperando você", `${current.title}: parado depois de ${stage.label}`);
        } else db.updateVideo(video.id, { status: "queued" });
      }
    } catch (err) {
      const stopped = controller.signal.aborted;
      db.updateStage(video.id, stage.name, { status: stopped ? "pending" : "error", progress: 0, message: stopped ? null : err.message, finished_at: Date.now() });
      if (!stopped) {
        db.updateVideo(video.id, { status: "error", error: `${stage.label}: ${err.message}` });
        db.log({ videoId: video.id, agent: stage.agent, level: "error", message: err.message });
        lastError.set(stage.agent, err.message);
      } else if (db.video(video.id)?.status === "running") db.updateVideo(video.id, { status: "queued" });
    } finally {
      running.delete(key);
      changed();
      tick();
    }
  }

  // --- Scripts ------------------------------------------------------------------------------------
  async function runScript(row) {
    const key = `script:${row.id}`;
    const controller = new AbortController();
    const adjusting = Boolean(row.pending_instruction && row.content);
    const entry = { agent: adjusting || row.research ? "script" : "research", scriptId: row.id, controller, resource: "llm" };
    running.set(key, entry);
    const ctxFor = (agentId) => context({ scriptId: row.id, agentId, signal: controller.signal });
    try {
      if (adjusting) {
        db.updateScript(row.id, { status: "writing", error: null });
        changed();
        const content = await script.adjust(ctxFor("script"), row, row.pending_instruction);
        db.saveScriptVersion(row.id, content, row.pending_instruction);
        db.updateScript(row.id, { status: "review", pending_instruction: null });
      } else {
        let found = row.research;
        if (!found) {
          db.updateScript(row.id, { status: "researching", error: null });
          changed();
          try {
            found = await research.run(ctxFor("research"), row);
            db.updateScript(row.id, { research: found });
            lastError.delete("research");
          } catch (err) {
            if (controller.signal.aborted) throw err;
            // A script without research is still a script; the creator sees that it had none.
            db.log({ scriptId: row.id, agent: "research", level: "warn", message: `Pesquisa indisponível (${err.message}). Escrevendo sem ela.` });
            lastError.set("research", err.message);
          }
        }
        entry.agent = "script";
        db.updateScript(row.id, { status: "writing" });
        changed();
        const content = await script.write(ctxFor("script"), { ...db.script(row.id) });
        db.saveScriptVersion(row.id, content, null);
        db.updateScript(row.id, { status: "review" });
      }
      lastError.delete("script");
      notify("Roteiro pronto para revisão", row.topic);
    } catch (err) {
      if (controller.signal.aborted) db.updateScript(row.id, { status: row.content ? "review" : "queued", pending_instruction: null });
      else {
        db.updateScript(row.id, { status: row.content ? "review" : "error", error: err.message, pending_instruction: null });
        db.log({ scriptId: row.id, agent: entry.agent, level: "error", message: err.message });
        lastError.set(entry.agent, err.message);
      }
    } finally {
      running.delete(key);
      changed();
      tick();
    }
  }

  // --- Scheduler -------------------------------------------------------------------------------------
  function tick() {
    if (quitting) return;
    const cfg = settings();
    if (cfg.paused) return;
    for (const row of db.scripts().reverse()) {
      if (row.status !== "queued" || running.has(`script:${row.id}`)) continue;
      if (used("llm") >= limits().llm) break;
      if (cfg.agentsPaused.script || (!row.research && cfg.agentsPaused.research)) continue;
      void runScript(row);
    }
    for (const video of db.videos()) {
      if (!["queued", "running"].includes(video.status) || running.has(`video:${video.id}`)) continue;
      const stages = stagesOf(video.id);
      const next = stages.find((s) => s.status !== "done" && s.status !== "skipped");
      if (!next || next.status !== "pending") continue;
      const stage = STAGES.find((s) => s.name === next.name);
      if (!stage || cfg.agentsPaused[stage.agent] || used(stage.resource) >= limits()[stage.resource]) continue;
      void runStage(video, stage);
    }
    for (const video of db.videos()) {
      if (!isShort(video) || video.status !== "queued" || running.has(`video:${video.id}`)) continue;
      if (cfg.agentsPaused.shorts || used("render") >= limits().render) continue;
      void runShort(video);
    }
  }

  // --- Shorts -------------------------------------------------------------------------------------
  // A Short is a video of its own (kind "short") made from a moment of a recording. It has no stages: one render,
  // then the same review, approval and publishing as any other video.
  const isShort = (video) => video?.data?.kind === "short";
  function shortRow(parentId, shortId) {
    return db.videos().find((v) => isShort(v) && v.data.parentId === parentId && v.data.shortId === shortId) ?? null;
  }
  const SHORT_FIELDS = ["start", "end", "frame", "focus", "captions", "hook", "tight", "story"];
// "subject" (where the character is, 0–1 across the frame) is not a render field: it sets "focus" for the framing.
  function shortMetadata(parent, item, before = null) {
    const from = parent.data.metadata ?? {};
    const base = before?.manual
      ? before
      : {
          title: item.title || parent.title,
          titles: [],
          body: [item.title || parent.title, parent.data.youtube?.url ? `Vídeo completo: ${parent.data.youtube.url}` : ""].filter(Boolean).join("\n\n"),
          tags: from.tags ?? [],
          hashtags: ["shorts", ...(from.hashtags ?? []).filter((h) => !/^shorts$/i.test(h)).slice(0, 2)],
          chapters: [],
          useChapters: false,
          category: from.category ?? 22,
          language: from.language ?? "pt-BR",
          notes: "",
        };
    return metadata.compose({ ...base, chapters: [], useChapters: false }, { cuts: [], credits: [] });
  }

  async function runShort(video) {
    const key = `video:${video.id}`;
    const controller = new AbortController();
    running.set(key, { agent: "shorts", videoId: video.id, controller, resource: "render" });
    db.updateVideo(video.id, { status: "running", error: null, data: { render: { progress: 0, message: "Na fila" } } });
    changed();
    let lastWrite = 0;
    const ctx = context({
      videoId: video.id,
      agentId: "shorts",
      signal: controller.signal,
      onProgress: (fraction, message) => {
        if (Date.now() - lastWrite < 400) return;
        lastWrite = Date.now();
        db.updateVideo(video.id, { data: { render: { progress: Math.max(0, Math.min(1, Number(fraction) || 0)), message: message ?? null } } });
        changed();
      },
    });
    try {
      const parent = db.video(video.data.parentId);
      if (!parent) throw new Error("O vídeo de origem deste Short não está mais no Estúdio.");
      const result = await shorts.render(ctx, { parent, parentDir: videoDir(parent.id), item: { ...video.data, title: video.title }, dir: videoDir(video.id) });
      if (!db.video(video.id)) return;
      db.updateVideo(video.id, { status: "review", data: { finalPath: result.path, cover: result.cover, duration: result.duration, renderedAt: Date.now(), render: null, dirty: false } });
      lastError.delete("shorts");
      notify("Short pronto para revisão", video.title);
    } catch (err) {
      const stopped = controller.signal.aborted;
      const current = db.video(video.id);
      if (!current) return;
      if (stopped) {
        if (current.status === "running") db.updateVideo(video.id, { status: "queued", data: { render: null } });
      } else {
        db.updateVideo(video.id, { status: "error", error: err.message, data: { render: null } });
        db.log({ videoId: video.id, agent: "shorts", level: "error", message: err.message });
        lastError.set("shorts", err.message);
      }
    } finally {
      running.delete(key);
      changed();
      tick();
    }
  }

  /** Makes (or makes again) the Shorts picked in the panel. Nothing is sent: each one waits for approval. */
  function makeShorts(parentId, ids, by = "você") {
    const parent = db.video(parentId);
    if (!parent || isShort(parent)) throw new Error("Vídeo de origem não encontrado.");
    if (!parent.data.duration) throw new Error("Este vídeo ainda não passou pela ingestão.");
    const made = [];
    for (const shortId of Array.isArray(ids) ? ids.map(Number) : []) {
      const item = (parent.data.shorts ?? []).find((s) => s.id === shortId);
      if (!item) continue;
      const fields = Object.fromEntries(SHORT_FIELDS.map((k) => [k, item[k] ?? null]));
      const defaults = settings().shorts;
      fields.frame = shorts.FRAMES.includes(fields.frame) ? fields.frame : defaults.frame;
      fields.captions = fields.captions ?? defaults.captions;
      if (!Number.isFinite(item.focus) && Number.isFinite(item.subject)) fields.focus = shorts.focusFor(item.subject, fields.frame, parent.data.width, parent.data.height);
      fields.hook = fields.hook ?? "";
      let row = shortRow(parentId, shortId);
      if (row?.data.youtube?.id) continue;
      if (row) {
        stopRunning((r) => r.videoId === row.id);
        approvals.revoke(row.id);
        db.updateVideo(row.id, { status: "queued", error: null, data: { ...fields, render: null } });
      } else {
        const id = db.addVideo({ title: item.title || parent.title, sourcePath: `short://${parentId}/${shortId}/${Date.now()}`, stages: [] });
        db.updateVideo(id, { data: { kind: "short", parentId, shortId, ...fields, metadata: shortMetadata(parent, item) } });
        db.log({ videoId: id, agent: "shorts", message: `${item.story ? "Story" : "Short"} pedido ${by === "você" ? "por você" : "pelo agente de Shorts"}: ${cut.clock(item.start)}–${cut.clock(item.end)} de "${parent.title}".` });
        row = db.video(id);
      }
      made.push(row.id);
    }
    changed();
    setTimeout(tick, 200);
    return made;
  }

  /**
   * The Shorts agent on its own: once a video is ready, its best suggested moments become Shorts and its best moment
   * a Story (vertical, up to 30 s, "VÍDEO NOVO NO CANAL" on top, to post by phone). Done once per video unless asked
   * again (`force`); what was already made is never made again. Nothing is sent: each one waits for approval.
   */
  function autoShorts(videoId, { force = false } = {}) {
    const cfg = settings();
    const video = db.video(videoId);
    if (!video || isShort(video) || video.status === "divided" || !video.data.duration) return { started: false };
    if (!force && (!cfg.shorts.auto || cfg.agentsPaused.shorts || video.data.autoShortsDone)) return { started: false };
    const key = `shorts-auto:${videoId}`;
    if (running.has(key)) return { started: false, busy: true };
    db.updateVideo(videoId, { data: { autoShortsDone: true } });
    void findAndMakeShorts(videoId, key);
    return { started: true };
  }

  /**
   * The Shorts agent on its own: it finds the moments (speech, action measured on the picture, and a look at the
   * frames of each one), then makes the best ones (score ≥ minScore, up to `count`) and one Story (vertical, up to
   * 30 s, "VÍDEO NOVO NO CANAL!" on top, to post by phone). What was already made is never made again, and nothing
   * is sent: each one waits for approval.
   */
  async function findAndMakeShorts(videoId, key) {
    const controller = new AbortController();
    running.set(key, { agent: "shorts", videoId, controller, resource: "llm" });
    changed();
    const ctx = context({ videoId, agentId: "shorts", signal: controller.signal });
    try {
      const cfg = settings();
      let video = db.video(videoId);
      const dir = videoDir(videoId);
      let story = null;
      if (llm.available()) {
        const game = (video.data.tracks ?? []).find((tr) => tr.role === "jogo");
        const measured = await visualCheck.analyse(video.source_path, video.data.duration, { dir, signal: controller.signal, gameStream: game ? game.index : null }).catch((err) => {
          if (controller.signal.aborted) throw err;
          ctx.log("warn", `Não consegui medir a imagem (${err.message}); procuro só pela fala.`);
          return null;
        });
        const found = await shorts.discover(ctx, { parent: video, parentDir: dir, visual: measured, fontFile: ["C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/arial.ttf"].find((f) => fs.existsSync(f)) ?? null });
        video = db.video(videoId);
        const list = [...(video.data.shorts ?? [])];
        let id = Math.max(0, ...list.map((s) => s.id));
        for (const m of found.moments) {
          if (list.some((s) => !s.story && Math.abs(s.start - m.start) < 3 && Math.abs(s.end - m.end) < 3)) continue;
          list.push({ ...m, id: ++id, source: "agente" });
        }
        if (found.story) story = found.story;
        db.updateVideo(videoId, { data: { shorts: list, shortsFound: Date.now() } });
      }
      video = db.video(videoId);
      const ideas = (video.data.shorts ?? []).filter((s) => !s.story);
      const best = ideas
        .filter((s) => !shortRow(videoId, s.id) && (s.score ?? 0) >= cfg.shorts.minScore)
        .sort((x, y) => y.score - x.score)
        .slice(0, Math.max(0, cfg.shorts.count));
      let storyItem = null;
      const top = story ?? [...ideas].sort((x, y) => y.score - x.score)[0];
      if (cfg.shorts.stories && top && !(video.data.shorts ?? []).some((s) => s.story)) {
        const id = Math.max(0, ...(video.data.shorts ?? []).map((s) => s.id)) + 1;
        storyItem = { id, start: top.start, end: Math.min(top.end, top.start + 30), title: `Story: ${video.title}`.slice(0, 100), reason: `Para divulgar o vídeo nos Stories (Instagram, WhatsApp, TikTok): "${top.title}", com o aviso de vídeo novo.`, score: top.score, ...(Number.isFinite(top.subject) ? { subject: top.subject } : {}), source: "story", story: true, frame: "fill", hook: "VÍDEO NOVO NO CANAL!", captions: true };
        db.updateVideo(videoId, { data: { shorts: [...(video.data.shorts ?? []), storyItem] } });
      }
      const ids = [...best.map((s) => s.id), ...(storyItem ? [storyItem.id] : [])];
      if (ids.length && llm.available()) {
        const now = db.video(videoId);
        const places = await shorts.locate(ctx, { parent: now, parentDir: dir, items: (now.data.shorts ?? []).filter((s) => ids.includes(s.id)), fontFile: ["C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/arial.ttf"].find((f) => fs.existsSync(f)) ?? null }).catch((err) => {
          if (controller.signal.aborted) throw err;
          ctx.log("warn", `Não consegui ver onde está o personagem (${err.message}); os Shorts saem centralizados.`);
          return new Map();
        });
        if (places.size) db.updateVideo(videoId, { data: { shorts: (db.video(videoId).data.shorts ?? []).map((s) => (places.has(s.id) ? { ...s, subject: places.get(s.id) } : s)) } });
      }
      if (ids.length) makeShorts(videoId, ids, "agente");
      db.log({
        videoId,
        agent: "shorts",
        level: "decision",
        message: best.length || storyItem
          ? `Agente de Shorts: ${best.length} Short(s) com nota ${cfg.shorts.minScore} ou mais${storyItem ? " e 1 Story" : ""} sendo gerados. Cada um espera a sua aprovação na aba Shorts.`
          : `Agente de Shorts: nenhum momento com nota ${cfg.shorts.minScore} ou mais neste vídeo; os que ele achou estão na aba Shorts para você gerar se quiser.`,
      });
      lastError.delete("shorts");
    } catch (err) {
      if (!controller.signal.aborted) {
        db.log({ videoId, agent: "shorts", level: "error", message: `Agente de Shorts: ${err.message}` });
        lastError.set("shorts", err.message);
      }
    } finally {
      running.delete(key);
      changed();
    }
  }

  /**
   * A Short as a vertical project (1080×1920) in the editor, to change it by hand: the same stretch, cuts, framing,
   * text on top and captions as the render, each as its own clip. Built once; after that the same file opens.
   */
  async function shortInEditor(parentId, shortId) {
    const parent = db.video(parentId);
    const item = (parent?.data.shorts ?? []).find((s) => s.id === Number(shortId));
    if (!parent || !item) throw new Error("Short não encontrado.");
    if (item.editorProject && fs.existsSync(item.editorProject)) {
      await showInEditor(item.editorProject);
      return { path: item.editorProject };
    }
    if (!fs.existsSync(parent.source_path)) throw new Error("A gravação original não foi encontrada.");
    if (used("render") >= limits().render) throw new Error("Todas as mesas de montagem do Estúdio estão ocupadas. Tente de novo quando uma terminar, ou aumente \"Vídeos ao mesmo tempo\" nas Configurações.");
    const cfg = settings();
    const frame = shorts.FRAMES.includes(item.frame) ? item.frame : cfg.shorts.frame;
    const focus = Number.isFinite(item.focus) ? item.focus : Number.isFinite(item.subject) ? shorts.focusFor(item.subject, frame, parent.data.width, parent.data.height) : 0.5;
    const parts = shorts.segments(item.start, item.end, item.tight === false ? [] : parent.data.cuts ?? []);
    const total = parts.reduce((sum, p) => sum + p.end - p.start, 0);
    const clean = parent.data.cleanAudioPath && fs.existsSync(parent.data.cleanAudioPath) ? parent.data.cleanAudioPath : null;
    const mixed = Boolean(clean) && (parent.data.audioStreams ?? 1) > 1 && (parent.data.voiceStream ?? 0) !== 0;
    const dir = path.join(videoDir(parentId), "shorts-editor");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `short-${item.id}.cena`);
    const key = `short-editor:${parentId}:${item.id}`;
    running.set(key, { agent: "shorts", videoId: parentId, controller: new AbortController(), resource: "render" });
    changed();
    try {
      await withWorker(async () => {
      await tool("new_project", { discardChanges: true });
      const imported = await tool("import_media", { paths: [parent.source_path, ...(clean ? [clean] : [])] }, 30 * 60_000);
      await tool("update_project", { name: item.title || parent.title, width: 1080, height: 1920, magnet: true, ...(frame === "fill" ? { backgroundMode: "color", background: "#000000" } : { backgroundMode: "blur", backgroundBlur: 40 }) });
      const picture = (imported.materials ?? []).find((m) => m.kind === "video" || m.hasVideo);
      if (!picture) throw new Error("O Cena não conseguiu importar a gravação.");
      const voice = clean ? (imported.materials ?? []).find((m) => m !== picture && (m.path ?? "").toLowerCase() === clean.toLowerCase()) ?? (imported.materials ?? []).find((m) => m !== picture && m.kind === "audio") : null;
      const pictureClips = [];
      let at = 0;
      for (const p of parts) {
        const clip = await tool("add_clip", { materialId: picture.id, start: at, sourceStart: p.start, duration: p.end - p.start });
        pictureClips.push(clip.id);
        if (voice) await tool("add_clip", { materialId: voice.id, start: clip.start ?? at, sourceStart: p.start, duration: p.end - p.start });
        // Half a frame past the real end, so frame rounding never lays the next piece over this one.
        at = (Number.isFinite(clip.end) ? clip.end : at + p.end - p.start) + 1 / 120;
      }
      await tool("update_clip", { clipIds: pictureClips, crop: shorts.cropFor(frame, focus, parent.data.width, parent.data.height), transform: { x: 0, y: 0, scale: 1 }, ...(voice ? { volume: mixed ? 0.6 : 0 } : {}) });
      if (voice) {
        const built = await tool("get_project");
        const under = (built.tracks ?? []).filter((tr) => tr.kind === "audio").flatMap((tr) => tr.clips ?? []).filter((c) => c.materialId !== voice.id).map((c) => c.id);
        if (under.length) await tool("update_clip", { clipIds: under, volume: mixed ? 0.6 : 0 });
      }
      const font = cfg.edit.font || "Arial Black";
      const spots = shorts.layout(frame, (parent.data.height ?? 0) > (parent.data.width ?? 1));
      const words = edit.readWords(videoDir(parentId)).filter((w) => w.end > item.start && w.start < item.end);
      if (item.captions !== false && words.length) {
        const lines = shorts.captionLines(words, parts).filter((l) => l.end > l.start && l.start < total);
        if (lines.length) await tool("add_captions", { lines, replace: true, y: +((spots.captions + 60) / 1920).toFixed(3), style: { fontFamily: font, fontSize: 52, bold: true, color: "#ffffff", strokeColor: "#000000", strokeWidth: 5, align: "center" } });
      }
      if (item.hook) await tool("add_text", { content: String(item.hook).toUpperCase(), start: 0, duration: total, style: { fontFamily: font, fontSize: 34, bold: true, color: cfg.edit.textColour || "#ffd400", strokeColor: "#000000", strokeWidth: 4, align: "center" }, transform: { x: 0, y: +((spots.title + 40) / 960 - 1).toFixed(3) } });
      await tool("save_project", { path: file, overwrite: true });
      await tool("new_project", { discardChanges: true });
      });
      db.updateVideo(parentId, { data: { shorts: (db.video(parentId).data.shorts ?? []).map((s) => (s.id === item.id ? { ...s, editorProject: file } : s)) } });
      db.log({ videoId: parentId, agent: "shorts", message: `"${item.title}" aberto no editor como projeto vertical (${path.basename(file)}). Mude o que quiser, salve (Ctrl+S) e exporte de lá.` });
    } finally {
      running.delete(key);
      changed();
      tick();
    }
    await showInEditor(file);
    return { path: file };
  }

  /**
   * The Short as the creator finished it in the editor and exported: that file becomes the Short (no render), and
   * waits for approval like any other before it can be sent. The file is only read.
   */
  async function useExportedShort(parentId, shortId, file) {
    const parent = db.video(parentId);
    const item = (parent?.data.shorts ?? []).find((s) => s.id === Number(shortId));
    if (!parent || !item) throw new Error("Short não encontrado.");
    if (!file || !fs.existsSync(file)) throw new Error("Escolha o vídeo que você exportou do editor.");
    const info = await probeStreams(file);
    const picture = info.streams.find((s) => s.codec_type === "video");
    const duration = Number(info.format?.duration ?? 0);
    if (!picture || !duration) throw new Error("Este arquivo não tem vídeo que eu consiga ler.");
    if (duration > 180) throw new Error(`O vídeo tem ${cut.clock(duration)}: um Short tem no máximo 3 minutos.`);
    const vertical = (picture.height ?? 0) > (picture.width ?? 0);
    let row = shortRow(parentId, item.id);
    if (row?.data.youtube?.id) throw new Error("Este Short já está no YouTube.");
    if (!row) {
      const id = db.addVideo({ title: item.title || parent.title, sourcePath: `short://${parentId}/${item.id}/${Date.now()}`, stages: [] });
      db.updateVideo(id, { data: { kind: "short", parentId, shortId: item.id, ...Object.fromEntries(SHORT_FIELDS.map((k) => [k, item[k] ?? null])), metadata: shortMetadata(parent, item) } });
      row = db.video(id);
    } else {
      stopRunning((r) => r.videoId === row.id);
      approvals.revoke(row.id);
    }
    const cover = path.join(videoDir(row.id), "capa.jpg");
    await ff(["-ss", Math.min(1, duration / 2).toFixed(2), "-i", file, "-frames:v", "1", "-vf", "scale=540:-2", "-q:v", "3", cover]).catch(() => {});
    db.updateVideo(row.id, { status: "review", error: null, data: { finalPath: file, cover: fs.existsSync(cover) ? cover : null, duration: +duration.toFixed(2), renderedAt: Date.now(), render: null, dirty: false, fromEditorExport: file } });
    db.log({ videoId: row.id, agent: "shorts", level: "decision", message: `Short "${item.title}" agora é o vídeo que você exportou do editor (${path.basename(file)}, ${Math.round(duration)} s${vertical ? "" : ", atenção: não está na vertical"}). Assista e aprove para poder enviar.` });
    changed();
    return { id: row.id, vertical };
  }

  /** Changes a suggested moment. If it was already rendered, it is rendered again and asks for approval again. */
  function setShort(parentId, shortId, patch) {
    const parent = db.video(parentId);
    const item = (parent?.data.shorts ?? []).find((s) => s.id === Number(shortId));
    if (!parent || !item || !patch || typeof patch !== "object") return;
    const row = shortRow(parentId, item.id);
    if (row?.data.youtube?.id) throw new Error("Este Short já está no YouTube. Altere-o pelo YouTube Studio.");
    const next = {};
    const duration = parent.data.duration ?? Infinity;
    if (Number.isFinite(Number(patch.start)) && patch.start !== null) next.start = +Math.max(0, Math.min(duration, Number(patch.start))).toFixed(2);
    if (Number.isFinite(Number(patch.end)) && patch.end !== null) next.end = +Math.max(0, Math.min(duration, Number(patch.end))).toFixed(2);
    const start = next.start ?? item.start;
    const end = next.end ?? item.end;
    if (end - start < shorts.MIN) throw new Error(`Um Short precisa de pelo menos ${shorts.MIN} segundos.`);
    if (end - start > shorts.MAX) throw new Error("Um Short tem no máximo 3 minutos.");
    if (typeof patch.title === "string" && patch.title.trim()) next.title = patch.title.trim().slice(0, 100);
    if (typeof patch.hook === "string") next.hook = patch.hook.trim().slice(0, 40);
    if (shorts.FRAMES.includes(patch.frame)) next.frame = patch.frame;
    if (typeof patch.captions === "boolean") next.captions = patch.captions;
    if (typeof patch.tight === "boolean") next.tight = patch.tight;
    if (Number.isFinite(Number(patch.focus)) && patch.focus !== null) next.focus = Math.max(0, Math.min(1, Number(patch.focus)));
    const differs = Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(item[k] ?? null));
    if (!differs.length) return;
    db.updateVideo(parentId, { data: { shorts: parent.data.shorts.map((s) => (s.id === item.id ? { ...s, ...next, edited: true } : s)) } });
    if (row) {
      const again = differs.some((k) => SHORT_FIELDS.includes(k));
      approvals.revoke(row.id);
      const data = Object.fromEntries(differs.filter((k) => SHORT_FIELDS.includes(k)).map((k) => [k, next[k]]));
      if (next.title && !row.data.metadata?.manual) data.metadata = shortMetadata(parent, { ...item, ...next });
      if (again) stopRunning((r) => r.videoId === row.id);
      db.updateVideo(row.id, { ...(next.title ? { title: next.title } : {}), data, status: again ? "queued" : row.status === "approved" ? "review" : row.status, ...(again ? { error: null } : {}) });
    }
    changed();
    setTimeout(tick, 300);
  }

  function removeShort(parentId, shortId) {
    const parent = db.video(parentId);
    if (!parent) return;
    const row = shortRow(parentId, Number(shortId));
    if (row?.data.youtube?.id) throw new Error("Este Short já está no YouTube; ele fica na lista. Para tirá-lo do canal, use o YouTube Studio.");
    if (row) api.removeVideo(row.id);
    db.updateVideo(parentId, { data: { shorts: (parent.data.shorts ?? []).filter((s) => s.id !== Number(shortId)) } });
    changed();
  }

  /** The AI panel of the Shorts tab: a request in plain words about one recording's moments. */
  async function askShorts(parentId, text) {
    const parent = db.video(parentId);
    const request = String(text ?? "").trim();
    if (!parent || isShort(parent) || !request) throw new Error("Escolha um vídeo e escreva o pedido.");
    const key = `shorts-ask:${parentId}`;
    if (running.has(key)) throw new Error("O agente de Shorts já está atendendo um pedido para este vídeo.");
    const controller = new AbortController();
    running.set(key, { agent: "shorts", videoId: parentId, controller, resource: "llm" });
    db.log({ videoId: parentId, agent: "shorts", message: `Pedido sobre Shorts: "${request}"` });
    changed();
    try {
      const outcome = await shorts.ask(context({ videoId: parentId, agentId: "shorts", signal: controller.signal }), { parent, parentDir: videoDir(parentId), text: request });
      const notes = [];
      for (const id of outcome.remove) {
        try {
          removeShort(parentId, id);
        } catch (err) {
          notes.push(err.message);
        }
      }
      for (const { id, ...change } of outcome.change) {
        try {
          setShort(parentId, id, change);
        } catch (err) {
          notes.push(err.message);
        }
      }
      const now = db.video(parentId);
      let lastId = Math.max(0, ...(now.data.shorts ?? []).map((s) => s.id));
      const added = outcome.add.map((s) => ({ ...s, id: ++lastId, source: "prompt" }));
      if (added.length) db.updateVideo(parentId, { data: { shorts: [...(now.data.shorts ?? []), ...added] } });
      const reply = [outcome.reply, ...notes].join(" ");
      db.log({ videoId: parentId, agent: "shorts", level: "decision", message: `${reply} (${added.length} novo(s), ${outcome.change.length} alterado(s), ${outcome.remove.length} removido(s))` });
      lastError.delete("shorts");
      return { reply, added: added.map((s) => s.id), changed: outcome.change.map((c) => c.id), removed: outcome.remove };
    } catch (err) {
      if (!controller.signal.aborted) {
        db.log({ videoId: parentId, agent: "shorts", level: "error", message: err.message });
        lastError.set("shorts", err.message);
      }
      throw err;
    } finally {
      running.delete(key);
      changed();
    }
  }

  function stopRunning(match) {
    for (const entry of running.values()) if (match(entry)) entry.controller.abort();
  }

  // --- What the panel can ask for ---------------------------------------------------------------------
  const cleanBrief = (given) => ({
    text: String(given?.text ?? "").trim().slice(0, 4000),
    stops: [...new Set(Array.isArray(given?.stops) ? given.stops : [])].filter((s) => director.STOPS.includes(s)),
  });
  const cleanAgents = (list) => (Array.isArray(list) ? CHOOSABLE.filter((name) => list.includes(name)) : null);

  /** Which agents work on a video. Stages already done stay done; the others follow the choice. */
  function applyAgents(videoId, agents) {
    const video = db.video(videoId);
    if (!video) return;
    const list = cleanAgents(agents);
    db.updateVideo(videoId, { data: { agents: list } });
    const now = db.video(videoId);
    for (const s of db.stages(videoId)) {
      if (!CHOOSABLE.includes(s.name) || s.name === "cut" || s.name === "assemble" || s.status === "done" || s.status === "running") continue;
      if (now.data.partOf && ["ingest", "cut", "audio"].includes(s.name)) continue;
      db.updateStage(videoId, s.name, { status: chosen(now, s.name) ? "pending" : "skipped" });
    }
  }

  /** `brief`: how the creator wants these recordings edited and where to stop for them. Without one, the usual from Settings. */
  function addVideos(files, scriptId = null, brief = null) {
    const added = [];
    const usual = settings().flow;
    const start = cleanBrief(brief && typeof brief === "object" ? brief : { text: usual.brief, stops: usual.stops });
    const agents = cleanAgents(brief && typeof brief === "object" ? brief.agents : usual.agents);
    for (const file of files) {
      if (!VIDEO_EXT.test(file) || db.videoByPath(file)) continue;
      const id = db.addVideo({ title: path.basename(file, path.extname(file)), sourcePath: file, scriptId, stages: STAGES.map((s) => s.name) });
      db.updateVideo(id, { data: { brief: start } });
      if (agents) applyAgents(id, agents);
      db.log({ videoId: id, agent: "ingest", message: `Entrou na fila: ${file}` });
      if (start.text) db.log({ videoId: id, agent: "director", message: `Seu pedido para este vídeo: "${start.text}"` });
      added.push(id);
    }
    changed();
    tick();
    return added;
  }

  // --- The creator's request and the stops ---------------------------------------------------------------
  /** Turns the settings-like part of the request into this video's overrides. A failure never holds the video. */
  async function readBrief(videoId, signal) {
    const video = db.video(videoId);
    const text = String(video?.data.brief?.text ?? "").trim();
    if (!text) return;
    const log = (level, message) => {
      db.log({ videoId, agent: "director", level, message });
      changed();
    };
    if (!llm.available()) return log("warn", "Sem o Claude Code não consigo ler o seu pedido. O vídeo segue com as configurações normais.");
    try {
      const out = await director.interpret(context({ videoId, agentId: "director", signal }), video, text);
      const now = db.video(videoId);
      if (!now) return;
      const before = now.data.overrides ?? {};
      const overrides = { ...before, edit: { ...(before.edit ?? {}), ...out.overrides.edit }, audio: { ...(before.audio ?? {}), ...out.overrides.audio }, cut: { ...(before.cut ?? {}), ...out.overrides.cut } };
      const stops = [...new Set([...(now.data.brief?.stops ?? []), ...out.stops])];
      const split = now.data.partOf ? null : out.split;
      db.updateVideo(videoId, { data: { overrides, brief: { ...now.data.brief, stops, split, notes: out.notes, readAt: Date.now() } } });
      lastError.delete("director");
      log("decision", `Pedido entendido. ${out.notes} [${out.said.join("; ") || "nenhuma configuração muda; os agentes de Corte e Edição leem o pedido"}]`);
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError.set("director", err.message);
      log("warn", `Não consegui ler o seu pedido (${err.message}). O vídeo segue; os agentes de Corte e Edição ainda leem o texto.`);
    }
  }

  /** Changes the request of a video already in the studio. `redoFrom` runs that stage and what follows again with it. */
  async function setBrief(videoId, patch, redoFrom = null) {
    const video = db.video(videoId);
    if (!video || isShort(video)) return;
    const before = video.data.brief ?? { text: "", stops: [] };
    const next = cleanBrief({ text: patch?.text ?? before.text, stops: patch?.stops ?? before.stops });
    const reworded = next.text !== before.text;
    db.updateVideo(videoId, { data: { brief: { ...before, ...next, ...(reworded ? { notes: null, readAt: null, split: null } : {}) } } });
    if (patch && "agents" in patch) applyAgents(videoId, patch.agents);
    if (reworded) db.log({ videoId, agent: "director", message: next.text ? `Pedido alterado: "${next.text}"` : "Pedido apagado." });
    changed();
    if (reworded && next.text && db.stage(videoId, "ingest")?.status === "done") {
      const key = `brief:${videoId}`;
      const controller = new AbortController();
      running.set(key, { agent: "director", videoId, controller, resource: "llm" });
      changed();
      try {
        await readBrief(videoId, controller.signal);
      } finally {
        running.delete(key);
        changed();
      }
    }
    if (redoFrom && STAGES.some((s) => s.name === redoFrom) && db.stage(videoId, "ingest")?.status === "done") redo(videoId, redoFrom);
  }

  // --- Cuts by hand, while the flow waits ------------------------------------------------------------------
  /** One tidy list: cuts that are ON never overlap, never leave a sliver between them, and win over suggestions. */
  function normalizeCuts(list, duration) {
    const valid = list.map((c) => ({ ...c, start: Math.max(0, Number(c.start)), end: Math.min(duration, Number(c.end)) })).filter((c) => c.end - c.start >= 0.25);
    const on = [];
    for (const c of valid.filter((x) => x.enabled).sort((a, b) => a.start - b.start)) {
      const last = on[on.length - 1];
      if (last && c.start - last.end < 0.35) {
        // The larger of the two names the joined cut.
        if (c.end - c.start > last.end - last.start) Object.assign(last, { kind: c.kind, reason: c.reason });
        last.end = Math.max(last.end, c.end);
      } else on.push({ ...c });
    }
    const off = [];
    for (const c of valid.filter((x) => !x.enabled)) {
      let { start, end } = c;
      for (const o of on) {
        if (o.end <= start || o.start >= end) continue;
        if (o.start <= start) start = Math.min(end, o.end);
        else end = o.start;
      }
      if (end - start >= 0.25) off.push({ ...c, start, end });
    }
    return [...on, ...off].sort((a, b) => a.start - b.start).map((c, i) => ({ ...c, id: i + 1, start: +c.start.toFixed(3), end: +c.end.toFixed(3) }));
  }

  /** The video whose cuts may be changed now: it went through the Cut agent and nothing is working on it. */
  function cutsOf(videoId) {
    const video = db.video(videoId);
    if (!video || isShort(video)) throw new Error("Vídeo não encontrado.");
    if (db.stage(videoId, "cut")?.status !== "done") throw new Error("Este vídeo ainda não passou pelo agente de Corte.");
    if (running.has(`video:${videoId}`)) throw new Error("Este vídeo está sendo processado. Pause-o para mexer nos cortes.");
    if (video.data.youtube?.id) throw new Error("Este vídeo já está no YouTube.");
    return video;
  }

  function saveCuts(video, list, message = null) {
    const cuts = normalizeCuts(list, video.data.duration);
    approvals.revoke(video.id);
    db.updateVideo(video.id, { data: { cuts, dirty: true, ...(video.data.metadata ? { metadata: composed(video, {}, { cuts }) } : {}) }, status: video.status === "approved" ? "review" : video.status });
    if (message) db.log({ videoId: video.id, agent: "cut", level: "decision", message });
    changed();
    return cuts;
  }
  const lengthWith = (video, cuts) => Math.max(0, video.data.duration - director.removed(cuts));

  function addCut(videoId, { start, end, reason = "" } = {}) {
    const video = cutsOf(videoId);
    const from = Number(start);
    const to = Number(end);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to - from < 0.25) throw new Error("O fim do corte precisa vir depois do início.");
    if (from < 0 || to > video.data.duration + 0.5) throw new Error(`Este vídeo vai de 0:00 a ${cut.clock(video.data.duration)}.`);
    const cuts = saveCuts(video, [...(video.data.cuts ?? []), { id: 0, start: from, end: to, kind: "manual", reason: String(reason).trim().slice(0, 160) || "Cortado por você", enabled: true }], `Corte feito por você: ${cut.clock(from)}–${cut.clock(to)}.`);
    return { duration: lengthWith(video, cuts) };
  }

  function removeCut(videoId, cutId) {
    const video = cutsOf(videoId);
    saveCuts(video, (video.data.cuts ?? []).filter((c) => c.id !== Number(cutId)));
  }

  /** Every cut of one kind on or off ("liga todos os trechos sem fala"). */
  function setCutKind(videoId, kind, enabled) {
    const video = cutsOf(videoId);
    const list = video.data.cuts ?? [];
    const count = list.filter((c) => c.kind === kind && c.enabled !== Boolean(enabled)).length;
    if (!count) return;
    saveCuts(video, list.map((c) => (c.kind === kind ? { ...c, enabled: Boolean(enabled) } : c)), `${count} cortes "${kind}" ${enabled ? "ligados" : "desligados"} por você.`);
  }

  /** A request in plain words about what to cut or keep. */
  async function askCuts(videoId, text) {
    const video = cutsOf(videoId);
    const request = String(text ?? "").trim();
    if (!request) throw new Error("Escreva o que cortar ou manter.");
    const key = `cuts-ask:${videoId}`;
    if (running.has(key)) throw new Error("O agente de Corte já está atendendo um pedido para este vídeo.");
    const controller = new AbortController();
    running.set(key, { agent: "cut", videoId, controller, resource: "llm" });
    db.log({ videoId, agent: "cut", message: `Pedido sobre os cortes: "${request}"` });
    changed();
    try {
      const outcome = await director.cuts(context({ videoId, agentId: "cut", signal: controller.signal }), { video, dir: videoDir(videoId), text: request });
      const before = lengthWith(video, video.data.cuts ?? []);
      const now = cutsOf(videoId);
      const cuts = outcome.changed ? saveCuts(now, outcome.cuts) : (now.data.cuts ?? []);
      const after = lengthWith(now, cuts);
      db.log({ videoId, agent: "cut", level: "decision", message: `${outcome.reply} [${outcome.applied.join("; ") || "nenhuma alteração"}] O vídeo vai de ${cut.clock(before)} para ${cut.clock(after)}.` });
      lastError.delete("cut");
      return { reply: outcome.reply, applied: outcome.applied, before, after };
    } catch (err) {
      if (!controller.signal.aborted) {
        db.log({ videoId, agent: "cut", level: "error", message: err.message });
        lastError.set("cut", err.message);
      }
      throw err;
    } finally {
      running.delete(key);
      changed();
    }
  }

  const samePath = (a, b) => path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();

  /** The stretches of the recording that a project saved by the editor still shows, in order. */
  function keptInProject(file, sourcePath) {
    const project = typeof file === "string" ? JSON.parse(fs.readFileSync(file, "utf8")) : file;
    const sources = [].concat(sourcePath).filter(Boolean);
    const ours = new Set(Object.values(project.materials ?? {}).filter((m) => m.hasVideo && sources.some((p) => samePath(m.path, p))).map((m) => m.id));
    const segments = (project.tracks ?? []).filter((t) => t.kind === "video").flatMap((t) => t.segments ?? []).filter((s) => ours.has(s.materialId)).sort((a, b) => a.start - b.start);
    if (!segments.length) throw new Error("O projeto salvo não tem mais a gravação original na linha do tempo.");
    if (segments.some((s) => s.speed !== 1)) throw new Error("O projeto salvo muda a velocidade de um trecho. No meio do fluxo só os cortes são aproveitados; deixe velocidade e efeitos para a revisão final.");
    // The studio describes a video as the recording minus cuts: it has to go forward, each stretch once.
    // An overlap of a few frames (a split a little off) is only trimmed.
    const TOLERANCE = 500_000;
    const end = (s) => s.sourceStart + s.duration;
    // The stretches out of place are the fewest (by length) whose removal leaves the rest in order: a highlight
    // copied to the start is named, not everything that follows it.
    const best = segments.map((s) => s.duration);
    const prev = segments.map(() => -1);
    for (let j = 0; j < segments.length; j++)
      for (let i = 0; i < j; i++)
        if (segments[j].sourceStart >= end(segments[i]) - TOLERANCE && best[i] + segments[j].duration > best[j]) {
          best[j] = best[i] + segments[j].duration;
          prev[j] = i;
        }
    const inOrder = new Set();
    for (let k = best.indexOf(Math.max(...best)); k >= 0; k = prev[k]) inOrder.add(k);
    const out = segments.filter((_, k) => !inOrder.has(k));
    if (out.length) {
      const where = out
        .slice(0, 3)
        .map((s) => `em ${cut.clock(s.start / 1e6)} da linha do tempo está o trecho ${cut.clock(s.sourceStart / 1e6)}–${cut.clock(end(s) / 1e6)} da gravação`)
        .join("; ");
      throw new Error(`A faixa principal não segue a gravação em ordem: ${where}${out.length > 3 ? ` e mais ${out.length - 3}` : ""}, fora do lugar ou repetido. Isso acontece quando um trecho é copiado (por exemplo, um destaque no começo) ou movido. O Estúdio só aproveita cortes: a gravação precisa seguir do começo para o fim, cada trecho uma vez.`);
    }
    // An overlap of a few frames (a split a little off) is only trimmed.
    let reached = -1;
    const kept = [];
    for (const s of segments) {
      const start = Math.max(s.sourceStart, reached);
      if (end(s) > start) kept.push({ start: start / 1e6, end: end(s) / 1e6 });
      reached = Math.max(reached, end(s));
    }
    return kept;
  }

  /** What is missing between kept stretches of a recording: the cuts. */
  function gapsOf(kept, duration) {
    const gaps = [];
    let at = 0;
    for (const k of [...kept].sort((a, b) => a.start - b.start)) {
      if (k.start - at >= 0.05) gaps.push({ start: at, end: Math.min(duration, k.start) });
      at = Math.max(at, k.end);
    }
    if (duration - at >= 0.05) gaps.push({ start: at, end: duration });
    return gaps.filter((g) => g.end - g.start >= 0.05);
  }

  /** Takes the cuts the creator made in the editor (in the project this studio opened for them) into the cut list. */
  function importEditorCuts(videoId, file = null) {
    const video = cutsOf(videoId);
    const made = file ? { path: file } : video.data.cutProject;
    if (!made?.path || !fs.existsSync(made.path)) throw new Error("Este vídeo ainda não foi aberto no editor pelo Estúdio.");
    const kept = keptInProject(made.path, [video.source_path, video.data.edit?.stablePath]);
    const duration = video.data.duration;
    const gaps = gapsOf(kept, duration);
    const old = video.data.cuts ?? [];
    const next = [];
    let fromEditor = 0;
    for (const gap of gaps) {
      const inside = old.filter((c) => c.enabled && c.start >= gap.start - 0.06 && c.end <= gap.end + 0.06);
      const covered = inside.reduce((sum, c) => sum + c.end - c.start, 0);
      // A gap that the list already explains keeps its reasons; anything else was cut by hand.
      if (covered >= gap.end - gap.start - 0.12) next.push(...inside);
      else {
        next.push({ id: 0, start: gap.start, end: gap.end, kind: "manual", reason: "Cortado por você no editor", enabled: true });
        fromEditor++;
      }
    }
    const restored = old.filter((c) => c.enabled && !next.includes(c) && !gaps.some((g) => c.start < g.end - 0.06 && c.end > g.start + 0.06));
    // Suggestions that were off stay as suggestions; cuts the creator undid in the editor become suggestions too.
    next.push(...old.filter((c) => !c.enabled), ...restored.map((c) => ({ ...c, enabled: false })));
    const stamp = fs.statSync(made.path).mtimeMs;
    const remember = () => !file && db.updateVideo(videoId, { data: { cutProject: { ...made, builtAt: stamp } } });
    if (!fromEditor && !restored.length) {
      remember();
      return { changed: false, duration: lengthWith(video, old) };
    }
    const cuts = saveCuts(video, next, `Cortes trazidos do editor: ${fromEditor} feitos por você${restored.length ? `, ${restored.length} desfeitos` : ""}. O vídeo fica com ${cut.clock(lengthWith(video, normalizeCuts(next, duration)))}.`);
    remember();
    return { changed: true, manual: fromEditor, restored: restored.length, duration: lengthWith(video, cuts) };
  }

  const editedInEditor = (video) => {
    const made = video?.data.cutProject;
    try {
      return Boolean(made?.path) && fs.statSync(made.path).mtimeMs > made.builtAt + 500;
    } catch {
      return false;
    }
  };

  async function showInEditor(file) {
    const win = openEditor();
    for (let i = 0; i < 60; i++) {
      try {
        await agent.callToolIn(win, "get_project", {}, 3000);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    try {
      await agent.callToolIn(win, "open_project", { path: file }, 60_000);
    } catch (err) {
      throw new Error(`O editor não abriu o projeto (${err.message}). Salve ou feche o projeto que está aberto nele e tente de novo. O arquivo está em ${file}`);
    }
  }

  /**
   * Opens the recording in the Cena editor with the cuts applied, so the creator can cut by hand.
   * It is a project of its own (cortes.cena): when they save it, "Continuar" takes its cuts into the flow.
   */
  async function openCutsInEditor(videoId) {
    let video = cutsOf(videoId);
    // What they already did in the editor is never thrown away by building the project again.
    if (editedInEditor(video)) {
      importEditorCuts(videoId);
      video = cutsOf(videoId);
    }
    const dir = videoDir(videoId);
    const file = path.join(dir, "cortes.cena");
    const stampOf = (cuts) => JSON.stringify(edit.mergedCuts(cuts));
    if (!(video.data.cutProject?.stamp === stampOf(video.data.cuts) && fs.existsSync(file))) {
      if (used("render") >= limits().render) throw new Error("Todas as mesas de montagem do Estúdio estão ocupadas. Tente de novo quando uma terminar, ou aumente \"Vídeos ao mesmo tempo\" nas Configurações.");
      const key = `cuts-project:${videoId}`;
      running.set(key, { agent: "assemble", videoId, controller: new AbortController(), resource: "render" });
      changed();
      try {
        await withWorker(async () => {
        await tool("new_project", { discardChanges: true });
        const imported = await tool("import_media", { paths: [video.source_path] }, 30 * 60_000);
        if (imported.failed?.length || !imported.materials?.[0]) throw new Error("O Cena não conseguiu importar a gravação.");
        await tool("add_clip", { materialId: imported.materials[0].id, start: 0 });
        const enabled = edit.mergedCuts(video.data.cuts);
        if (enabled.length) await tool("remove_ranges", { ranges: enabled });
        await tool("update_project", { name: `${video.title} (cortes)` });
        await tool("save_project", { path: file, overwrite: true });
        await tool("new_project", { discardChanges: true });
        });
        db.updateVideo(videoId, { data: { cutProject: { path: file, builtAt: fs.statSync(file).mtimeMs, stamp: stampOf(video.data.cuts) } } });
        db.log({ videoId, agent: "cut", message: "Projeto de cortes aberto no editor do Cena. Corte lá, salve (Ctrl+S) e volte aqui para continuar." });
      } finally {
        running.delete(key);
        changed();
        tick();
      }
    }
    await showInEditor(file);
    return { path: file };
  }

  /** The click on "Continuar": the flow goes on from where it stopped, with the cuts as they are now. */
  function continueVideo(videoId, { ignoreEditor = false } = {}) {
    const video = db.video(videoId);
    if (!video || isShort(video)) return null;
    let imported = null;
    if (!ignoreEditor && editedInEditor(video) && db.stage(videoId, "cut")?.status === "done" && !running.has(`video:${videoId}`)) imported = importEditorCuts(videoId);
    for (const s of db.stages(videoId)) if (s.status === "error") db.updateStage(videoId, s.name, { status: "pending", message: null });
    const done = finished(videoId);
    db.updateVideo(videoId, { status: done ? "review" : "queued", error: null, data: { hold: null } });
    if (video.data.hold) db.log({ videoId, agent: "director", level: "decision", message: `Você mandou continuar. O vídeo segue com ${cut.clock(lengthWith(db.video(videoId), db.video(videoId).data.cuts ?? []))}.` });
    changed();
    tick();
    return imported;
  }

  /** Put a stage and everything that depends on it back to "to do". */
  function redo(videoId, from) {
    stopRunning((r) => r.videoId === videoId);
    const at = STAGES.findIndex((s) => s.name === from);
    if (at < 0) return;
    const video = db.video(videoId);
    for (const name of REDO[from]) db.updateStage(videoId, name, { status: chosen(video, name) || name === "cut" || name === "assemble" ? "pending" : "skipped", progress: 0, message: null, result: null });
    approvals.revoke(videoId);
    db.updateVideo(videoId, { status: "queued", error: null, data: { hold: null, renderMine: null, ...(from === "ingest" || from === "cut" || from === "split" ? { children: null } : {}) } });
    db.log({ videoId, agent: STAGES[at].agent, message: `Etapa "${STAGES[at].label}" refeita a pedido.` });
    changed();
    setTimeout(tick, 300);
  }

  /** Redo one stage alone (new thumbnails do not need a new render). */
  function redoOnly(videoId, name) {
    const stage = STAGES.find((s) => s.name === name);
    if (!stage || !db.video(videoId)) return;
    stopRunning((r) => r.videoId === videoId);
    db.updateStage(videoId, name, { status: "pending", progress: 0, message: null, result: null });
    approvals.revoke(videoId);
    db.updateVideo(videoId, { status: "queued", error: null, data: { hold: null } });
    db.log({ videoId, agent: stage.agent, message: `Etapa "${stage.label}" refeita a pedido.` });
    changed();
    setTimeout(tick, 300);
  }

  /** A change that needs a new render: the approval falls and the video says so. */
  function touch(videoId, data) {
    const video = db.video(videoId);
    if (!video) return;
    approvals.revoke(videoId);
    db.updateVideo(videoId, { data: { ...data, dirty: true }, status: video.status === "approved" ? "review" : video.status });
    changed();
  }

  /** Videos of the same series: parts of one recording, or videos sent together by the editor's AI. */
  function seriesOf(video) {
    const key = video.data.series?.name ?? (video.data.partOf ? `parte:${video.data.partOf.parentId}` : null);
    if (!key) return [];
    return db.videos().filter((v) => (v.data.series?.name ?? (v.data.partOf ? `parte:${v.data.partOf.parentId}` : null)) === key);
  }

  /**
   * A release plan: the videos go out one after the other, every `everyDays` days from `start` (YYYY-MM-DD), at
   * `time` ("HH:MM") or at the channel's best hour. Each video still needs the creator's approval: the schedule only
   * says when YouTube publishes it once it is approved and sent.
   */
  async function scheduleSeries(ids, { start, everyDays = 2, time = "best" } = {}) {
    const list = (Array.isArray(ids) ? ids : []).map(Number).map((id) => db.video(id)).filter(Boolean);
    if (!list.length) throw new Error("Escolha os vídeos.");
    const posted = list.find((v) => v.data.youtube?.id);
    if (posted) throw new Error(`"${posted.title}" já está no YouTube.`);
    const days = Math.max(1, Math.min(30, Math.round(Number(everyDays) || 1)));
    let hour = 18;
    let minute = 0;
    if (/^\d{1,2}:\d{2}$/.test(String(time))) [hour, minute] = String(time).split(":").map(Number);
    else {
      const best = await publisher.suggest(list[0].id).catch(() => null);
      if (best?.bestHours?.length) hour = best.bestHours[0];
    }
    const first = /^\d{4}-\d{2}-\d{2}$/.test(String(start)) ? new Date(`${start}T00:00:00`) : new Date(Date.now() + 86_400_000);
    first.setHours(hour, minute, 0, 0);
    if (first.getTime() < Date.now() + 20 * 60_000) first.setDate(first.getDate() + 1);
    const planned = [];
    list.forEach((video, i) => {
      const at = new Date(first);
      at.setDate(first.getDate() + i * days);
      api.setSchedule(video.id, { at: at.getTime() });
      planned.push({ id: video.id, title: video.title, at: at.getTime() });
    });
    db.log({ agent: "publish", level: "decision", message: `Lançamentos programados, um a cada ${days} dia(s) às ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}: ${planned.map((p) => `"${p.title}" em ${new Date(p.at).toLocaleDateString("pt-BR")}`).join("; ")}. Cada vídeo ainda precisa da sua aprovação.` });
    changed();
    return planned;
  }

  // --- Back from the end, and from the editor ---------------------------------------------------------------
  /** The agents' project (or the creator's) was saved in the editor after the studio last built or rendered it. */
  const projectChanged = (video) => {
    try {
      return Boolean(video?.data.projectPath && video.data.projectBuiltAt) && fs.statSync(video.data.projectPath).mtimeMs > video.data.projectBuiltAt + 500;
    } catch {
      return false;
    }
  };

  function idle(videoId) {
    const video = db.video(videoId);
    if (!video || isShort(video)) throw new Error("Vídeo não encontrado.");
    if (running.has(`video:${videoId}`)) throw new Error("Este vídeo está sendo processado. Pause-o antes.");
    if (video.data.youtube?.id) throw new Error("Este vídeo já está no YouTube.");
    return video;
  }

  /** Opens the video's project in the editor (the one the agents built, or the creator's copy). */
  async function openProjectInEditor(videoId) {
    const video = idle(videoId);
    const file = video.data.projectPath;
    if (!file || !fs.existsSync(file)) throw new Error("Este vídeo ainda não tem projeto montado.");
    if (!video.data.projectBuiltAt) db.updateVideo(videoId, { data: { projectBuiltAt: fs.statSync(file).mtimeMs } });
    db.log({ videoId, agent: "assemble", message: "Projeto aberto no editor. Mude o que quiser, salve (Ctrl+S) e volte: dá para renderizar como está ou voltar ao início com os cortes de lá." });
    changed();
    await showInEditor(file);
    return { path: file };
  }

  /** "Renderizar como está no editor": the creator's changes are the video now. */
  function renderAsEdited(videoId) {
    const video = idle(videoId);
    const file = video.data.projectPath;
    if (!file || !fs.existsSync(file)) throw new Error("Este vídeo ainda não tem projeto montado.");
    db.updateVideo(videoId, { data: { renderMine: file } });
    db.log({ videoId, agent: "assemble", level: "decision", message: "Você pediu para renderizar o projeto como ele está no editor." });
    redoOnly(videoId, "assemble");
  }

  /**
   * Back to the start of the flow, like the stop after the Cut: the cuts can be changed (here or in the editor),
   * the request too, and "Continuar" builds and renders the video again. What the agents found is kept.
   * `fromEditor`: take the cuts of the project the creator changed in the editor first.
   */
  function backToStart(videoId, { fromEditor = false } = {}) {
    let video = idle(videoId);
    if (db.stage(videoId, "cut")?.status !== "done") throw new Error("Este vídeo ainda não passou pelo agente de Corte.");
    let imported = null;
    if (fromEditor && video.data.projectPath && fs.existsSync(video.data.projectPath)) {
      imported = importEditorCuts(videoId, video.data.projectPath);
      video = db.video(videoId);
    }
    approvals.revoke(videoId);
    for (const name of ["edit", "assemble"]) if (db.stage(videoId, name)) db.updateStage(videoId, name, { status: chosen(video, name) || name === "assemble" ? "pending" : "skipped", progress: 0, message: null, result: null });
    db.updateVideo(videoId, { status: "hold", error: null, data: { hold: { after: "cut", at: Date.now() }, renderMine: null, dirty: true } });
    db.log({ videoId, agent: "director", level: "decision", message: `De volta ao início${imported?.changed ? `, com os cortes do editor (${imported.manual} feitos por você)` : ""}. Mude os cortes ou o pedido e clique em Continuar: a edição e a montagem são refeitas.` });
    changed();
    return imported;
  }

  /**
   * A project open in the editor goes to the studio: its recording, the cuts made in it, the request and the agents.
   * The project itself is kept beside the video, untouched, for the Assembly to render as it is when it is not asked for.
   */
  function sendFromEditor({ project, projectPath = null, brief = null, order = false, series = null, title: given = null, exported = null } = {}) {
    if (!project || !Array.isArray(project.tracks)) throw new Error("Projeto inválido.");
    if (exported) return sendExported({ project, projectPath, brief, series, title: given, file: String(exported) });
    const materials = project.materials ?? {};
    const isRecording = (m) => m?.hasVideo && m.kind !== "image" && m.path;
    // The main track is the video track that shows the most of a recording on screen: time × size of the picture.
    // A webcam shrunk to a corner (the same length as the game) never wins; on a tie, the lower track (the editor's
    // main one, at the bottom) does.
    const tracks = project.tracks.filter((t) => t.kind === "video" && !t.hidden);
    const shown = (s) => Math.min(1, Math.abs(Number(s.transform?.scale ?? 1)) || 1) ** 2 * (Number(s.transform?.opacity ?? 1) > 0 ? 1 : 0);
    const length = (t) => (t.segments ?? []).filter((s) => isRecording(materials[s.materialId])).reduce((sum, s) => sum + s.duration * shown(s), 0);
    const main = tracks.reduce((best, t) => (!best || length(t) >= length(best) * 0.98 ? t : best), null);
    const used = [...new Set((main?.segments ?? []).filter((s) => isRecording(materials[s.materialId])).map((s) => materials[s.materialId].path))];
    if (!used.length) throw new Error("O projeto não tem nenhum vídeo na linha do tempo.");
    const missing = used.find((p) => !fs.existsSync(p));
    if (missing) throw new Error(`A gravação não está mais no lugar: ${missing}`);
    const wanted = cleanAgents(brief?.agents);
    // The creator's (or the editor AI's) project is rendered as it is: the recording only has to be listened to,
    // for the title and the thumbnail, so its stretches are taken in order of the recording, whatever the edit.
    const mineOnly = Array.isArray(wanted) && !wanted.includes("assemble");
    if (order && !mineOnly) return sendInOrder({ project, projectPath, brief, main, materials, isRecording, series, title: given });
    const first = used[0];
    if (!mineOnly && used.length > 1) throw new Error(`A faixa principal junta ${used.length} gravações. O Estúdio só aproveita cortes de uma gravação.`);
    if (!mineOnly && (main.segments ?? []).some((s) => isRecording(materials[s.materialId]) && Number(s.speed ?? 1) !== 1)) throw new Error("A faixa principal tem um trecho com a velocidade mudada. O Estúdio só aproveita cortes de uma gravação.");
    const source = mineOnly ? [...used].sort((a, b) => (main.segments ?? []).filter((s) => materials[s.materialId]?.path === b).length - (main.segments ?? []).filter((s) => materials[s.materialId]?.path === a).length)[0] : first;
    const kept = mineOnly ? looseKept(main, materials, source) : keptInProject({ ...project, tracks: [main] }, source);
    const start = cleanBrief(brief);
    const agents = cleanAgents(brief?.agents);
    const name = String(given ?? project.name ?? "").trim();
    const title = name && name !== "Novo projeto" ? name : path.basename(source, path.extname(source));
    const id = db.addVideo({ title, sourcePath: source, stages: STAGES.map((s) => s.name) });
    if (series) db.updateVideo(id, { data: { series: { name: String(series).slice(0, 120) } } });
    const copy = path.join(videoDir(id), "projeto-do-editor.cena");
    fs.writeFileSync(copy, JSON.stringify(project));
    const extras = project.tracks.filter((t) => t !== main).reduce((sum, t) => sum + (t.segments ?? []).length, 0);
    db.updateVideo(id, { data: { brief: start, editorKept: kept, fromEditor: { path: projectPath, copy, extras } } });
    if (agents) applyAgents(id, agents);
    db.log({ videoId: id, agent: "ingest", message: `Veio do editor${projectPath ? ` (${path.basename(projectPath)})` : ""}: ${source}` });
    if (start.text) db.log({ videoId: id, agent: "director", message: `Seu pedido para este vídeo: "${start.text}"` });
    const now = db.video(id);
    if (chosen(now, "assemble") && extras) db.log({ videoId: id, agent: "assemble", level: "warn", message: `Do seu projeto vieram a gravação e os cortes. Os outros ${extras} itens (textos, sons e outras faixas) não entram na montagem dos agentes; o seu projeto fica guardado como estava.` });
    if (!chosen(now, "assemble")) db.log({ videoId: id, agent: "assemble", message: "Sem a Montagem dos agentes: no fim, o seu projeto é renderizado como está, com os títulos e thumbnails que os agentes fizerem." });
    changed();
    tick();
    return id;
  }

  /**
   * The creator already exported the video from the editor: that file is the video. The agents only listen to it
   * (for the title, description, chapters and thumbnails, in its own times); there is no cutting and no render.
   * The file is read, never changed.
   */
  function sendExported({ project, projectPath, brief, series, title: given, file }) {
    if (!fs.existsSync(file)) throw new Error(`O vídeo exportado não foi encontrado: ${file}`);
    const start = cleanBrief(brief);
    const agents = (cleanAgents(brief?.agents) ?? ["metadata", "thumbnail"]).filter((a) => a === "metadata" || a === "thumbnail");
    const name = String(given ?? project?.name ?? "").trim();
    const title = name && name !== "Novo projeto" ? name : path.basename(file, path.extname(file));
    const id = db.addVideo({ title, sourcePath: file, stages: STAGES.map((s) => s.name) });
    if (series) db.updateVideo(id, { data: { series: { name: String(series).slice(0, 120) } } });
    const copy = path.join(videoDir(id), "projeto-do-editor.cena");
    if (project) fs.writeFileSync(copy, JSON.stringify(project));
    db.updateVideo(id, { data: { brief: start, exported: file, fromEditor: { path: projectPath, copy, extras: 0 } } });
    applyAgents(id, agents);
    for (const name of ["audio", "edit", "split"]) db.updateStage(id, name, { status: "skipped" });
    db.log({ videoId: id, agent: "ingest", message: `Veio do editor já exportado: ${file}. Os agentes só escutam o vídeo para ${agents.map((a) => (a === "metadata" ? "título, descrição e capítulos" : "as thumbnails")).join(" e ")}; nada é cortado nem renderizado de novo.` });
    changed();
    tick();
    return id;
  }

  /** The stretches of `source` the main track uses, merged and in order of the recording. */
  function looseKept(main, materials, source) {
    const ranges = (main.segments ?? [])
      .filter((s) => materials[s.materialId]?.path === source)
      .map((s) => ({ start: s.sourceStart / 1e6, end: (s.sourceStart + s.duration * (Number(s.speed) > 0 ? Number(s.speed) : 1)) / 1e6 }))
      .sort((a, b) => a.start - b.start);
    const out = [];
    for (const r of ranges) {
      const last = out[out.length - 1];
      if (last && r.start <= last.end + 0.05) last.end = Math.max(last.end, r.end);
      else out.push({ ...r });
    }
    return out;
  }

  /** The main track as it is, in the editor's order, becomes a new recording that the agents work on. */
  function sendInOrder({ project, projectPath, brief, main, materials, isRecording, series = null, title: given = null }) {
    const segments = (main.segments ?? [])
      .filter((s) => isRecording(materials[s.materialId]) && s.duration > 0)
      .sort((a, b) => a.start - b.start)
      .map((s) => ({ path: materials[s.materialId].path, from: s.sourceStart / 1e6, length: s.duration / 1e6, speed: Number(s.speed) > 0 ? Number(s.speed) : 1 }));
    if (!segments.length) throw new Error("O projeto não tem nenhum vídeo na linha do tempo.");
    const start = cleanBrief(brief);
    const agents = cleanAgents(brief?.agents);
    const name = String(given ?? project.name ?? "").trim();
    const first = segments[0].path;
    const title = name && name !== "Novo projeto" ? name : path.basename(first, path.extname(first));
    const id = db.addVideo({ title, sourcePath: `ordem://${Date.now()}`, stages: STAGES.map((s) => s.name) });
    if (series) db.updateVideo(id, { data: { series: { name: String(series).slice(0, 120) } } });
    const dir = videoDir(id);
    db.setSource(id, path.join(dir, "gravacao-na-ordem-do-editor.mkv"));
    const copy = path.join(dir, "projeto-do-editor.cena");
    fs.writeFileSync(copy, JSON.stringify(project));
    const extras = project.tracks.filter((t) => t !== main).reduce((sum, t) => sum + (t.segments ?? []).length, 0);
    const length = segments.reduce((sum, s) => sum + s.length, 0);
    db.updateVideo(id, { data: { brief: start, fromEditor: { path: projectPath, copy, extras, ordered: true }, flatten: { segments, width: project.width || 1920, height: project.height || 1080, fps: project.fps || 30, done: false } } });
    if (agents) applyAgents(id, agents);
    db.log({ videoId: id, agent: "ingest", message: `Veio do editor, na ordem do editor: ${segments.length} trechos, ${cut.clock(length)}. Primeiro o Estúdio monta um arquivo novo com eles (as suas gravações não são mexidas).` });
    if (start.text) db.log({ videoId: id, agent: "director", message: `Seu pedido para este vídeo: "${start.text}"` });
    const now = db.video(id);
    if (chosen(now, "assemble") && extras) db.log({ videoId: id, agent: "assemble", level: "warn", message: `Do seu projeto veio a faixa principal. Os outros ${extras} itens (textos, sons e outras faixas) não entram na montagem dos agentes; o seu projeto fica guardado como estava.` });
    changed();
    tick();
    return id;
  }

  // --- Parts of one recording --------------------------------------------------------------------------------
  function partsOf(videoId) {
    const video = idle(videoId);
    if (video.data.children?.length) throw new Error("Os vídeos desta gravação já foram criados.");
    if (db.stage(videoId, "audio")?.status !== "done" && db.stage(videoId, "audio")?.status !== "skipped") throw new Error("A divisão vem depois do Áudio.");
    return video;
  }

  /** The creator changed the parts by hand (times, titles, one more, one less). */
  function setParts(videoId, list) {
    const video = partsOf(videoId);
    const parts = director.cleanParts(list, video.data.duration);
    db.updateVideo(videoId, { data: { parts } });
    changed();
    return parts;
  }

  /** A new request about the parts ("a terceira começa antes", "faz 3 em vez de 4"). */
  async function askParts(videoId, text) {
    const video = partsOf(videoId);
    const request = String(text ?? "").trim();
    if (!request) throw new Error("Escreva como dividir.");
    const key = `parts-ask:${videoId}`;
    if (running.has(key)) throw new Error("O Diretor já está atendendo um pedido para este vídeo.");
    const controller = new AbortController();
    running.set(key, { agent: "director", videoId, controller, resource: "llm" });
    db.log({ videoId, agent: "director", message: `Pedido sobre as partes: "${request}"` });
    changed();
    try {
      const ctx = context({ videoId, agentId: "director", signal: controller.signal });
      const out = await director.splitParts(ctx, { video, dir: videoDir(videoId), text: `${video.data.brief?.text ?? ""}\n\nNow: ${request}`, want: video.data.brief?.split ?? null, workspace: path.join(root, "agentes"), ff, previous: video.data.parts ?? [] });
      db.updateVideo(videoId, { data: { parts: out.parts, partsReply: out.reply } });
      db.log({ videoId, agent: "director", level: "decision", message: `${out.reply} ${out.parts.length} partes.` });
      return out;
    } finally {
      running.delete(key);
      changed();
    }
  }

  /**
   * "Criar os vídeos": each part becomes a video of its own, with everything the recording already went through
   * (transcript, cuts, cleaned sound) and the creator's request, and goes on from the Edit agent.
   */
  function makeParts(videoId) {
    const video = partsOf(videoId);
    const parts = director.cleanParts(video.data.parts, video.data.duration);
    if (!parts.length) throw new Error("Não há partes para criar.");
    const from = videoDir(videoId);
    const brief = video.data.brief ?? { text: "", stops: [] };
    const children = [];
    parts.forEach((part, i) => {
      const title = `${video.title} - ${i + 1}${part.title && !/^parte \d+$/i.test(part.title) ? ` - ${part.title}` : ""}`;
      const id = db.addVideo({ title, sourcePath: video.source_path, scriptId: video.script_id, stages: STAGES.map((s) => s.name) });
      const dir = videoDir(id);
      for (const file of ["transcricao.json", "capa.jpg"]) if (fs.existsSync(path.join(from, file))) fs.copyFileSync(path.join(from, file), path.join(dir, file));
      const outside = gapsOf([{ start: part.start, end: part.end }], video.data.duration).map((g) => ({ id: 0, ...g, kind: "parte", reason: `Fora da parte ${i + 1}`, enabled: true }));
      const inside = (video.data.cuts ?? []).filter((c) => c.end > part.start && c.start < part.end);
      const keep = ["duration", "width", "height", "fps", "audioStreams", "tracks", "audioPath", "cleanAudioPath", "stems", "overrides", "agents", "summary"];
      const data = Object.fromEntries(keep.filter((k) => video.data[k] !== undefined).map((k) => [k, video.data[k]]));
      db.updateVideo(id, {
        data: {
          ...data,
          thumb: fs.existsSync(path.join(dir, "capa.jpg")) ? path.join(dir, "capa.jpg") : (video.data.thumb ?? null),
          brief: { text: `${brief.text}\n\nEste é o vídeo ${i + 1} de ${parts.length} feitos desta gravação: "${part.title}" (${cut.clock(part.start)}–${cut.clock(part.end)}). ${part.reason}`.trim(), stops: (brief.stops ?? []).filter((s) => s !== "cut"), notes: brief.notes ?? null, readAt: Date.now() },
          fixedCuts: [...(video.data.fixedCuts ?? []), ...outside],
          cuts: normalizeCuts([...inside, ...outside], video.data.duration),
          shorts: (video.data.shorts ?? []).filter((s) => s.start >= part.start && s.end <= part.end),
          partOf: { parentId: videoId, index: i + 1, count: parts.length, start: part.start, end: part.end },
        },
      });
      for (const name of ["ingest", "cut"]) db.updateStage(id, name, { status: "done", progress: 1 });
      db.updateStage(id, "audio", { status: db.stage(videoId, "audio")?.status === "done" ? "done" : "skipped", progress: 1 });
      db.updateStage(id, "split", { status: "skipped" });
      const child = db.video(id);
      for (const name of ["edit", "metadata", "thumbnail"]) if (!chosen(child, name)) db.updateStage(id, name, { status: "skipped" });
      db.log({ videoId: id, agent: "director", message: `Parte ${i + 1} de ${parts.length} de "${video.title}": ${cut.clock(part.start)}–${cut.clock(part.end)}. ${part.reason}` });
      children.push(id);
    });
    for (const name of ["edit", "metadata", "thumbnail", "assemble"]) db.updateStage(videoId, name, { status: "skipped" });
    db.updateVideo(videoId, { status: "divided", data: { children, hold: null } });
    db.log({ videoId, agent: "director", level: "decision", message: `${children.length} vídeos criados a partir desta gravação. Cada um segue da Edição em diante.` });
    changed();
    tick();
    return children;
  }

  async function correct(videoId, text) {
    const video = db.video(videoId);
    if (!video || running.has(`video:${videoId}`)) throw new Error("Este vídeo está sendo processado.");
    const key = `video:${videoId}`;
    const controller = new AbortController();
    running.set(key, { agent: "review", videoId, controller, resource: "llm" });
    db.updateVideo(videoId, { status: "running" });
    db.log({ videoId, agent: "review", message: `Correção pedida: "${text}"` });
    changed();
    let from = null;
    let only = null;
    try {
      const outcome = await review.run(context({ videoId, agentId: "review", signal: controller.signal }), video, text);
      db.updateVideo(videoId, { data: outcome.data });
      from = outcome.redoFrom;
      only = outcome.redoOnly ?? null;
      lastError.delete("review");
      return { reply: outcome.reply, applied: outcome.applied, redoFrom: from ?? only };
    } catch (err) {
      if (!controller.signal.aborted) {
        db.log({ videoId, agent: "review", level: "error", message: err.message });
        lastError.set("review", err.message);
      }
      throw err;
    } finally {
      running.delete(key);
      db.updateVideo(videoId, { status: "review" });
      // New thumbnails asked for together with another change.
      if (only && from) db.updateStage(videoId, only, { status: "pending", progress: 0, message: null, result: null });
      if (from) redo(videoId, from);
      else if (only) redoOnly(videoId, only);
      changed();
    }
  }

  const api = {
    state() {
      const cfg = settings();
      return {
        stages: STAGES.map(({ name, label, agent: a }) => ({ name, label, agent: a })),
        videos: db.videos().map((v) => ({ ...v, projectChanged: projectChanged(v), stages: stagesOf(v.id).map(({ name, status, progress, message, attempt }) => ({ name, status, progress, message, attempt })), approval: approvals.current(v.id) })),
        scripts: db.scripts().map((s) => ({ ...s, research: s.research ? { summary: s.research.summary, references: s.research.references, patterns: s.research.patterns, confidence: s.research.confidence, limits: s.research.limits, source: s.research.source ?? "web" } : null })),
        youtube: youtube.status(),
        categories: metadata.CATEGORIES,
        agents: AGENTS.map((a) => {
          const jobs = [...running.values()].filter((r) => r.agent === a.id);
          return { ...a, status: jobs.length ? "running" : cfg.agentsPaused[a.id] ? "paused" : lastError.has(a.id) ? "error" : "idle", jobs: jobs.length, error: lastError.get(a.id) ?? null };
        }),
        settings: cfg,
        voice: voice(),
        system,
        claude: llm.available(),
        deepFilter: fs.existsSync(deepFilterExe),
        root,
      };
    },
    logs: (filter) => db.logs(filter ?? {}),
    async pickVideos() {
      const res = await dialog.showOpenDialog(studioWindow, { title: "Adicionar vídeos brutos", properties: ["openFile", "multiSelections"], filters: [{ name: "Vídeo", extensions: ["mp4", "mov", "mkv", "m4v", "webm"] }] });
      return res.canceled ? [] : res.filePaths;
    },
    /**
     * A "Cena Estúdio" icon on the Desktop that opens only the studio, apart from the editor. Only when the creator
     * clicks the button; an icon already there is replaced (it points to the same Cena).
     */
    studioShortcut() {
      if (process.platform !== "win32") throw new Error("O atalho só existe no Windows.");
      const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
      const link = path.join(app.getPath("desktop"), "Cena Estúdio.lnk");
      const args = [...(app.isPackaged ? [] : [`"${app.getAppPath()}"`]), "--abrir-estudio"].join(" ");
      const ok = shell.writeShortcutLink(link, fs.existsSync(link) ? "replace" : "create", { target: exe, args, description: "Abre só o Estúdio do Cena", icon: exe, iconIndex: 0 });
      if (!ok) throw new Error("O Windows não deixou criar o atalho.");
      return link;
    },
    async pickFolder() {
      const res = await dialog.showOpenDialog(studioWindow, { title: "Pasta monitorada", properties: ["openDirectory", "createDirectory"] });
      return res.canceled ? null : res.filePaths[0];
    },
    addVideos,
    setSettings(patch) {
      const before = settings().watch;
      const next = merge(settings(), patch);
      // Only recordings that arrive after the folder was chosen: what was already there stays untouched.
      if (next.watch.enabled && (!before.enabled || before.folder !== next.watch.folder)) {
        try {
          next.watch.ignore = fs.readdirSync(next.watch.folder).filter((name) => VIDEO_EXT.test(name));
        } catch {
          next.watch.ignore = [];
        }
      }
      db.setSetting("settings", next);
      watcher.apply(settings().watch);
      changed();
      tick();
      publisher.pump();
    },
    setVoice(text) {
      db.setSetting("voiceProfile", { ...voice(), text: String(text), updated: Date.now() });
      changed();
    },
    pauseAgent(id, paused) {
      api.setSettings({ agentsPaused: { [id]: Boolean(paused) } });
    },
    /** Stop: what it is doing goes back to the queue and it takes nothing new until started again. */
    stopAgent(id) {
      api.setSettings({ agentsPaused: { [id]: true } });
      stopRunning((r) => r.agent === id);
    },
    pauseVideo(id) {
      stopRunning((r) => r.videoId === id);
      db.updateVideo(id, { status: "paused" });
      changed();
    },
    resumeVideo(id) {
      const video = db.video(id);
      if (!video) return;
      for (const s of db.stages(id)) if (s.status === "error") db.updateStage(id, s.name, { status: "pending", message: null });
      db.updateVideo(id, { status: finished(id) ? "review" : "queued", error: null, data: { hold: null } });
      changed();
      tick();
    },
    redo,
    setBrief,
    continueVideo,
    sendFromEditor,
    scheduleSeries,
    /** What the editor's AI needs to know about the studio's videos. */
    overviewForAgent() {
      return db.videos().filter((v) => !isShort(v)).map((v) => ({
        id: v.id,
        title: v.title,
        status: v.status,
        series: v.data.series?.name ?? (v.data.partOf ? `parte de #${v.data.partOf.parentId}` : null),
        stages: Object.fromEntries(stagesOf(v.id).map((s) => [s.name, s.status])),
        title_suggested: v.data.metadata?.title ?? null,
        thumbnails: (v.data.thumbnails ?? []).map((t) => t.text),
        schedule: v.data.schedule?.at ? new Date(v.data.schedule.at).toISOString() : null,
        approved: v.status === "approved",
        youtube: v.data.youtube?.id ? { id: v.data.youtube.id, publishAt: v.data.youtube.publishAt ?? null } : null,
        error: v.error ?? null,
      }));
    },
    setAgents: (videoId, agents) => {
      applyAgents(videoId, agents);
      changed();
    },
    setParts,
    askParts,
    makeParts,
    backToStart,
    renderAsEdited,
    openProjectInEditor,
    addCut,
    removeCut,
    setCutKind,
    askCuts,
    openCutsInEditor,
    importEditorCuts,
    /** Editing choices for this video only (captions on or off, music volume...). Applied at the next render. */
    setEdit(videoId, patch) {
      const video = db.video(videoId);
      if (!video || !patch || typeof patch !== "object") return;
      touch(videoId, { overrides: { ...(video.data.overrides ?? {}), edit: { ...(video.data.overrides?.edit ?? {}), ...patch } } });
    },
    /** Turn one planned zoom, text, transition or support image on or off. */
    setEditItem(videoId, kind, itemId, enabled) {
      const video = db.video(videoId);
      const plan = video?.data.edit;
      if (!plan || !["zooms", "texts", "sections", "broll"].includes(kind)) return;
      touch(videoId, { edit: { ...plan, [kind]: (plan[kind] ?? []).map((item) => (item.id === itemId ? { ...item, enabled: Boolean(enabled) } : item)) } });
    },
    setEditText(videoId, itemId, text) {
      const video = db.video(videoId);
      const plan = video?.data.edit;
      if (!plan || !String(text ?? "").trim()) return;
      touch(videoId, { edit: { ...plan, texts: (plan.texts ?? []).map((item) => (item.id === itemId ? { ...item, text: String(text).trim().slice(0, 48) } : item)) } });
    },
    /** The thumbnail is part of what gets approved: choosing another one asks for approval again. */
    setThumbnail(videoId, index) {
      const video = db.video(videoId);
      const chosen = video?.data.thumbnails?.[index];
      if (!chosen || chosen.path === video.data.thumbnail) return;
      approvals.revoke(videoId);
      db.updateVideo(videoId, { data: { thumbnail: chosen.path }, status: video.status === "approved" ? "review" : video.status });
      changed();
    },
    /**
     * The thumbnail editor. `edits`: { design, extras: { texts, images: [{ path, x, y, w }] } }. Without `save` it draws a
     * preview without the extras (the editor shows those itself, to drag them); with `save` the finished picture becomes a
     * new option, chosen at once. The original option stays.
     */
    async editThumbnail(videoId, index, edits, save = false) {
      const video = db.video(videoId);
      const t = video?.data.thumbnails?.[index];
      if (!t || !fs.existsSync(t.path)) throw new Error("Esta thumbnail não existe mais. Gere outras.");
      const folder = path.dirname(t.path);
      // Thumbnails made before the editor: the picture itself is the background, and things are added over it.
      const base = t.design && fs.existsSync(path.join(folder, t.design.frameFile)) ? t.design : { text: "", frameFile: path.basename(t.path), plain: true, faceFile: null, assetFile: null };
      const want = edits?.design ?? {};
      const pick = (v, fallback) => (v === undefined ? fallback : v);
      const design = {
        ...base,
        text: String(pick(want.text, base.text) ?? "").slice(0, 60),
        accent: String(pick(want.accent, base.accent) ?? ""),
        textAt: pick(want.textAt, base.textAt),
        colour: pick(want.colour, base.colour),
        zoom: pick(want.zoom, base.zoom),
        arrow: pick(want.arrow, base.arrow),
        ring: pick(want.ring, base.ring),
        faceAt: pick(want.faceAt, base.faceAt),
        image: pick(want.image, base.image),
        // Only what this design already had can be kept or taken out.
        frameFile: base.frameFile,
        faceFile: want.faceFile === null ? null : (t.design?.originalFace ?? base.faceFile),
        originalFace: t.design?.originalFace ?? base.faceFile ?? null,
        assetFile: want.assetFile === null ? null : (t.design?.originalAsset ?? base.assetFile),
        originalAsset: t.design?.originalAsset ?? base.assetFile ?? null,
      };
      const texts = (edits?.extras?.texts ?? []).filter((x) => String(x?.text ?? "").trim()).slice(0, 12).map((x) => ({ text: String(x.text).slice(0, 80), x: Number(x.x), y: Number(x.y), size: Number(x.size), colour: x.colour }));
      const images = [];
      for (const m of (edits?.extras?.images ?? []).slice(0, 12)) {
        const src = String(m?.path ?? "");
        if (!/\.(png|jpe?g|webp)$/i.test(src) || !fs.existsSync(src)) continue;
        // A copy goes next to the thumbnail; the creator's file is only read.
        const name = `extra-${require("node:crypto").createHash("sha1").update(src).digest("hex").slice(0, 10)}${path.extname(src).toLowerCase()}`;
        if (path.resolve(src) !== path.resolve(folder, name) && !fs.existsSync(path.join(folder, name))) fs.copyFileSync(src, path.join(folder, name));
        images.push({ path: src, file: name, x: Number(m.x), y: Number(m.y), w: Number(m.w) });
      }
      const stamp = Date.now().toString(36);
      const colour = settings().edit.textColour || "#ffd400";
      if (!save) {
        for (const old of fs.readdirSync(folder)) if (old.startsWith("previa-")) fs.rmSync(path.join(folder, old), { force: true });
        return thumbnailArt.redraw({ folder, design, extras: null, out: path.join(folder, `previa-${stamp}.jpg`), render: thumbnail.render, colour });
      }
      const out = await thumbnailArt.redraw({ folder, design, extras: { texts, images }, out: path.join(folder, `thumb-${stamp}-editada.jpg`), render: thumbnail.render, colour });
      for (const old of fs.readdirSync(folder)) if (old.startsWith("previa-")) fs.rmSync(path.join(folder, old), { force: true });
      const now = db.video(videoId);
      const list = [...(now.data.thumbnails ?? [])];
      const made = { path: out, text: design.text || t.text, layout: "editada por você", time: t.time, person: Boolean(design.faceFile), design: { ...design, extras: { texts, images: images.map(({ path: p, x, y, w }) => ({ path: p, x, y, w })) } } };
      list.splice(index + 1, 0, made);
      approvals.revoke(videoId);
      db.updateVideo(videoId, { data: { thumbnails: list, thumbnail: out }, status: now.status === "approved" ? "review" : now.status });
      db.log({ videoId, agent: "thumbnail", message: "Você editou uma thumbnail; a versão editada virou uma opção nova e está escolhida." });
      changed();
      return out;
    },
    /** request: the text wanted, or { text, note, images } (how the creator wants it, and images they attached). */
    redoThumbnails(videoId, request) {
      const video = db.video(videoId);
      if (!video || !video.data.duration) return;
      const r = typeof request === "object" && request ? request : { text: request };
      const wanted = String(r.text ?? "").trim().slice(0, 40);
      const note = String(r.note ?? "").trim().slice(0, 600);
      const images = (Array.isArray(r.images) ? r.images : []).map(String).filter((f) => /\.(png|jpe?g|webp)$/i.test(f) && fs.existsSync(f)).slice(0, 6);
      const asked = wanted || note || images.length ? { ...(wanted ? { text: wanted } : {}), ...(note ? { note } : {}), ...(images.length ? { images } : {}) } : null;
      db.updateVideo(videoId, { data: { thumbnailRequest: asked } });
      if (note || images.length) db.log({ videoId, agent: "thumbnail", message: `Pedido para as thumbnails novas: ${[note, ...images.map((f) => `imagem ${path.basename(f)}`)].filter(Boolean).join(" · ")}` });
      redoOnly(videoId, "thumbnail");
    },
    /** Images for a thumbnail, chosen by the creator. They are only read (a copy goes into the thumbnail's folder). */
    async pickImages() {
      const res = await dialog.showOpenDialog(studioWindow, { title: "Imagens para a thumbnail", properties: ["openFile", "multiSelections"], filters: [{ name: "Imagens", extensions: ["png", "jpg", "jpeg", "webp"] }] });
      return res.canceled ? [] : res.filePaths;
    },
    setPriority(id, priority) {
      db.updateVideo(id, { priority: Math.round(priority) });
      changed();
    },
    setVideo(id, patch) {
      const allowed = {};
      if (typeof patch.title === "string" && patch.title.trim()) allowed.title = patch.title.trim();
      if ("script_id" in patch) allowed.script_id = patch.script_id;
      db.updateVideo(id, allowed);
      changed();
    },
    removeVideo(id) {
      const parts = db.videos().filter((v) => v.data.partOf?.parentId === id);
      // The parts use this recording's cleaned sound and transcript, which live in its folder.
      if (parts.length) throw new Error(`Esta gravação deu origem a ${parts.length} vídeos. Apague-os antes.`);
      for (const child of db.videos().filter((v) => isShort(v) && v.data.parentId === id)) api.removeVideo(child.id);
      publisher.cancel(id);
      stopRunning((r) => r.videoId === id);
      db.removeVideo(id);
      // Only what the studio made; the original recording is never touched.
      fs.rm(path.join(root, "videos", String(id)), { recursive: true, force: true }, () => {});
      changed();
    },
    setCut(videoId, cutId, enabled) {
      const video = db.video(videoId);
      if (!video) return;
      const cuts = (video.data.cuts ?? []).map((c) => (c.id === cutId ? { ...c, enabled: Boolean(enabled) } : c));
      approvals.revoke(videoId);
      db.updateVideo(videoId, { data: { cuts, dirty: true, ...(video.data.metadata ? { metadata: composed(video, {}, { cuts }) } : {}) }, status: video.status === "approved" ? "review" : video.status });
      changed();
    },
    /** Title, description, tags and chapters are part of what gets approved: changing them asks for approval again. */
    setMetadata(videoId, patch) {
      const video = db.video(videoId);
      if (!video || !patch || typeof patch !== "object") return;
      if (video.data.youtube?.id) throw new Error("Este vídeo já está no YouTube. Altere os dados dele pelo YouTube Studio.");
      const next = {};
      if (typeof patch.title === "string") next.title = patch.title;
      if (typeof patch.body === "string") next.body = patch.body;
      if (Array.isArray(patch.tags)) next.tags = patch.tags.map(String);
      if (Array.isArray(patch.hashtags)) next.hashtags = patch.hashtags.map(String);
      if (typeof patch.useChapters === "boolean") next.useChapters = patch.useChapters;
      if (metadata.CATEGORIES[Number(patch.category)]) next.category = Number(patch.category);
      if (Array.isArray(patch.chapters)) next.chapters = patch.chapters.filter((c) => c && Number.isFinite(Number(c.time)) && String(c.title ?? "").trim()).map((c) => ({ time: Number(c.time), title: String(c.title) }));
      if (!Object.keys(next).length) return;
      const base = video.data.metadata ?? { title: video.title, titles: [], body: "", tags: [], hashtags: [], chapters: [], useChapters: true, category: 22, language: "pt-BR", notes: "" };
      approvals.revoke(videoId);
      db.updateVideo(videoId, { data: { metadata: metadata.compose({ ...base, ...next, manual: true }, { cuts: video.data.cuts ?? [], credits: video.data.credits ?? [] }) }, status: video.status === "approved" ? "review" : video.status });
      changed();
    },
    /** Ask the Metadata agent for new suggestions. What was typed by hand is kept unless `fresh`. */
    redoMetadata(videoId, fresh = false) {
      const video = db.video(videoId);
      if (!video || !video.data.duration) return;
      if (video.data.youtube?.id) throw new Error("Este vídeo já está no YouTube. Altere os dados dele pelo YouTube Studio.");
      if (fresh && video.data.metadata) db.updateVideo(videoId, { data: { metadata: { ...video.data.metadata, manual: false } } });
      redoOnly(videoId, "metadata");
    },
    /** When it goes public. Part of the approval too. `at` null means "as soon as it is sent". */
    setSchedule(videoId, { at = null, privacy = null } = {}) {
      const video = db.video(videoId);
      if (!video) return;
      if (video.data.youtube?.id) throw new Error("Este vídeo já está no YouTube. Mude a data dele pelo YouTube Studio.");
      const when = at == null ? null : Number(at);
      if (when != null && (!Number.isFinite(when) || when < Date.now() + 15 * 60_000)) throw new Error("Escolha um horário pelo menos 15 minutos à frente.");
      const mode = ["public", "unlisted", "private"].includes(privacy) ? privacy : null;
      const schedule = when == null && !mode ? null : { at: when, privacy: when != null ? "public" : mode };
      if (JSON.stringify(schedule) === JSON.stringify(video.data.schedule ?? null)) return;
      approvals.revoke(videoId);
      db.updateVideo(videoId, { data: { schedule }, status: video.status === "approved" ? "review" : video.status });
      db.log({ videoId, agent: "publish", message: when ? `Agendado para ${new Date(when).toLocaleString("pt-BR")}. Vale depois da sua aprovação.` : "Agendamento removido." });
      changed();
    },
    suggestSchedule: (videoId) => publisher.suggest(videoId),
    /** The click on "Enviar ao YouTube". Refuses anything that is not approved exactly as it is. */
    publish: (videoId) => {
      if (db.video(videoId)?.data.story) throw new Error("Story não vai ao YouTube: abra a pasta e poste pelo celular (Instagram, WhatsApp ou TikTok).");
      return publisher.request(videoId);
    },
    autoShorts: (videoId) => autoShorts(Number(videoId), { force: true }),
    shortInEditor: (parentId, shortId) => shortInEditor(Number(parentId), Number(shortId)),

    // --- Publishing what was finished in the editor ------------------------------------------------
    /**
     * What this editor project already is in the studio: a Short of a recording opened with "Abrir no editor", or a
     * video or Short published from the editor before (it is replaced, not added again). null: nothing yet.
     */
    shortForProject(projectPath) {
      if (!projectPath) return null;
      const same = (x, y) => Boolean(x && y) && path.resolve(String(x)).toLowerCase() === path.resolve(String(y)).toLowerCase();
      const videos = db.videos();
      for (const v of videos) {
        const item = (v.data.shorts ?? []).find((s) => same(s.editorProject, projectPath));
        if (!item) continue;
        const row = shortRow(v.id, item.id);
        return { kind: "short", parentId: v.id, shortId: item.id, rowId: row?.id ?? null, title: row?.data.metadata?.title ?? item.title, body: row?.data.metadata?.body ?? "", schedule: row?.data.schedule?.at ?? null, sent: Boolean(row?.data.youtube?.id) };
      }
      const mine = videos.find((v) => v.data.mine && same(v.data.editorProject, projectPath) && !v.data.youtube?.id);
      if (mine) return { kind: isShort(mine) ? "short" : "video", parentId: null, shortId: null, rowId: mine.id, title: mine.data.metadata?.title ?? mine.title, body: mine.data.metadata?.body ?? "", schedule: mine.data.schedule?.at ?? null, sent: false };
      return null;
    },
    /** Where the editor writes the video it hands to the studio: inside the studio's folder, never over a file of the creator. */
    exportTarget(name) {
      const dir = path.join(root, "exportados-do-editor");
      fs.mkdirSync(dir, { recursive: true });
      const safe = String(name || "video").replace(/[<>:"/\\|?*\x00-\x1f]+/g, " ").trim().slice(0, 60) || "video";
      return path.join(dir, `${safe} ${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.mp4`);
    },
    /**
     * The video exported from the editor goes to the studio ready: title, description and date. It still needs the
     * creator's approval in the studio before anything is sent (the date only counts after it).
     * A Short opened from the studio takes the place of that Short; anything else becomes a video of its own.
     */
    async publishFromEditor({ projectPath = null, file, title = "", body = "", at = null, kind = "video" }) {
      if (!file || !fs.existsSync(file)) throw new Error("O vídeo exportado não foi encontrado.");
      const link = api.shortForProject(projectPath);
      const info = await probeStreams(file);
      const duration = Number(info.format?.duration ?? 0);
      const picture = info.streams.find((s) => s.codec_type === "video");
      if (!picture || !duration) throw new Error("Este arquivo não tem vídeo que eu consiga ler.");
      const asShort = link?.parentId ? true : kind === "short";
      if (asShort && duration > 180) throw new Error(`O vídeo tem ${cut.clock(duration)}: um Short tem no máximo 3 minutos.`);
      const name = String(title).trim() || path.basename(file, path.extname(file));
      let videoId;
      if (link?.parentId) {
        // A Short of a recording: the version edited here takes the agents' place.
        if (link.sent) throw new Error("Este Short já está no YouTube. Mude os dados dele pelo YouTube Studio.");
        videoId = (await useExportedShort(link.parentId, link.shortId, file)).id;
      } else {
        const known = link?.rowId && db.video(link.rowId);
        if (known && isShort(known) !== asShort) {
          // Published before as the other kind: the old entry goes, this one takes its place.
          api.removeVideo(known.id);
        }
        const reuse = known && isShort(known) === asShort ? known : null;
        videoId = reuse ? reuse.id : db.addVideo({ title: name, sourcePath: asShort ? `short://editor/${Date.now()}` : file, stages: asShort ? [] : STAGES.map((s) => s.name) });
        if (reuse) {
          stopRunning((r) => r.videoId === videoId);
          approvals.revoke(videoId);
        }
        const base = { title: name, titles: [], body: String(body), tags: [], hashtags: asShort ? ["shorts"] : [], chapters: [], useChapters: false, category: 20, language: "pt-BR", notes: "", manual: true };
        const cover = path.join(videoDir(videoId), "capa.jpg");
        await ff(["-y", "-ss", Math.min(1, duration / 2).toFixed(2), "-i", file, "-frames:v", "1", "-vf", "scale=480:-2", cover]).catch(() => {});
        const shared = { mine: true, editorProject: projectPath, exported: file, finalPath: file, duration: +duration.toFixed(2), width: picture.width, height: picture.height, renderedAt: Date.now(), dirty: false, metadata: metadata.compose(base, { cuts: [], credits: [] }) };
        db.updateVideo(videoId, {
          status: "review",
          error: null,
          data: asShort
            ? { ...shared, kind: "short", parentId: null, shortId: null, cover: fs.existsSync(cover) ? cover : null }
            : { ...shared, finalDuration: duration, thumb: fs.existsSync(cover) ? cover : null, agents: [], fromEditor: { path: projectPath, copy: null, extras: 0 } },
        });
        if (!asShort && !reuse) for (const s of STAGES) db.updateStage(videoId, s.name, { status: "skipped" });
        db.log({ videoId, agent: "publish", message: `Veio pronto do editor como ${asShort ? "Short" : "vídeo"} (${path.basename(file)}, ${cut.clock(duration)}). Nenhum agente mexe nele; falta só a sua aprovação.` });
      }
      db.updateVideo(videoId, { data: { mine: true, editorProject: projectPath } });
      if (title || body) api.setMetadata(videoId, { ...(title ? { title: String(title) } : {}), ...(body ? { body: String(body) } : {}) });
      if (at) api.setSchedule(videoId, { at: Number(at) });
      changed();
      return { videoId, short: asShort };
    },
    /** Opens in the editor the project a video or Short published from the editor came from. */
    async openMineInEditor(videoId) {
      const file = db.video(videoId)?.data.editorProject;
      if (!file || !fs.existsSync(file)) throw new Error("O projeto do editor deste vídeo não foi encontrado.");
      await showInEditor(file);
    },
    async useExportedShort(parentId, shortId, file = null) {
      if (file) return useExportedShort(Number(parentId), Number(shortId), String(file));
      const res = await dialog.showOpenDialog(studioWindow, { title: "O Short que você exportou do editor", properties: ["openFile"], filters: [{ name: "Vídeo", extensions: ["mp4", "mov", "mkv", "webm", "m4v"] }] });
      if (res.canceled || !res.filePaths[0]) return null;
      return useExportedShort(Number(parentId), Number(shortId), res.filePaths[0]);
    },
    growth: () => db.setting("growth", null),
    async growthTips() {
      if (running.has("growth")) throw new Error("Já estou analisando o canal; espere terminar.");
      const controller = new AbortController();
      running.set("growth", { agent: "research", controller, resource: "llm" });
      changed();
      try {
        const overview = youtube.connected() ? await publisher.overview().catch((err) => (db.log({ agent: "research", level: "warn", message: `Canal não lido: ${err.message}` }), null)) : null;
        const recordings = db
          .videos()
          .filter((v) => !isShort(v) && v.data.duration && v.status !== "divided")
          .slice(0, 20)
          .map((v) => {
            const ideas = (v.data.shorts ?? []).filter((s) => !s.story);
            return { id: v.id, title: v.title, duration: v.data.duration, status: v.status, published: Boolean(v.data.youtube?.id), ideas: ideas.length, best: ideas.length ? Math.max(...ideas.map((s) => s.score ?? 0)) : null, made: ideas.filter((s) => shortRow(v.id, s.id)).length };
          });
        const out = await growth.run(context({ agentId: "research", signal: controller.signal }), { overview, recordings, trends: trendsData() });
        db.setSetting("growth", out);
        lastError.delete("research");
        return out;
      } catch (err) {
        if (!controller.signal.aborted) {
          db.log({ agent: "research", level: "error", message: `Dicas para crescer: ${err.message}` });
          lastError.set("research", err.message);
        }
        throw err;
      } finally {
        running.delete("growth");
        changed();
      }
    },
    cancelGrowth() {
      running.get("growth")?.controller.abort();
    },
    /** An idea from the growth tips becomes a script. */
    scriptFromGrowth(index) {
      const idea = db.setting("growth", null)?.ideas?.[index];
      if (!idea) throw new Error("Ideia não encontrada.");
      const id = db.addScript({ topic: idea.title, tone: "natural", durationTarget: idea.format === "short" ? 45 : 480, format: idea.format });
      db.log({ scriptId: id, agent: "script", message: `Roteiro pedido a partir das dicas para crescer: ${idea.why}` });
      changed();
      tick();
      return id;
    },
    cancelPublish: (videoId) => publisher.cancel(videoId),
    channel: () => publisher.overview(),
    setYouTubeKeys(keys) {
      const saved = youtube.setKeys(keys ?? {});
      changed();
      return saved;
    },
    async connectYouTube() {
      const channel = await youtube.connect();
      db.log({ agent: "publish", level: "decision", message: `Canal "${channel.title}" conectado por você.` });
      changed();
      return channel;
    },
    async disconnectYouTube() {
      for (const v of db.videos()) if (["queued", "uploading", "waiting"].includes(v.data.publish?.status)) publisher.cancel(v.id);
      await youtube.disconnect();
      db.log({ agent: "publish", message: "Canal do YouTube desconectado." });
      changed();
    },
    openLink(url) {
      if (!/^https:\/\/(youtu\.be|www\.youtube\.com|studio\.youtube\.com|console\.cloud\.google\.com|myaccount\.google\.com)\//.test(String(url))) throw new Error("Endereço não permitido.");
      void shell.openExternal(String(url));
    },
    correct,
    makeShorts,
    setShort,
    removeShort,
    askShorts,
    async approve(videoId) {
      const video = db.video(videoId);
      if (!video || video.status !== "review") throw new Error("Só um vídeo em revisão pode ser aprovado.");
      if (video.data.dirty) throw new Error("Há alterações ainda não renderizadas. Aplique-as antes de aprovar.");
      await approvals.approve(video);
      db.updateVideo(videoId, { status: "approved" });
      db.log({ videoId, agent: "review", level: "decision", message: "Aprovado por você. A publicação só aceita este arquivo, com estes dados, exatamente como estão." });
      changed();
      if (settings().publish.auto && youtube.connected() && !video.data.youtube?.id && !video.data.story) await publisher.request(videoId).catch((err) => db.log({ videoId, agent: "publish", level: "warn", message: `Envio automático não iniciado: ${err.message}` }));
    },
    reject(videoId) {
      approvals.revoke(videoId);
      db.updateVideo(videoId, { status: "rejected" });
      db.log({ videoId, agent: "review", level: "decision", message: "Rejeitado por você." });
      changed();
    },
    reopen(videoId) {
      approvals.revoke(videoId);
      db.updateVideo(videoId, { status: "review" });
      changed();
    },
    reveal: (file) => fs.existsSync(file) && shell.showItemInFolder(file),

    // --- Trends -------------------------------------------------------------------------------------
    trends: () => trendsData(),
    async searchTrends({ topic, days, format }) {
      const ctx = context({ agentId: "research", signal: new AbortController().signal });
      const found = await trends.search(ctx, { topic, days: days ? Number(days) : null, format });
      // The last 8 searches stay to come back to; the same subject and period replaces the old one.
      const searches = [found, ...trendsData().searches.filter((s) => !(s.topic.toLowerCase() === found.topic.toLowerCase() && s.days === found.days && s.format === found.format))].slice(0, 8);
      saveTrends({ searches });
      changed();
      return found;
    },
    deleteTrendSearch(at) {
      saveTrends({ searches: trendsData().searches.filter((s) => s.at !== at) });
    },
    async pickReferenceVideos() {
      const res = await dialog.showOpenDialog(studioWindow, { title: "Vídeos de referência (do seu computador)", properties: ["openFile", "multiSelections"], filters: [{ name: "Vídeo", extensions: ["mp4", "mov", "mkv", "m4v", "webm"] }] });
      return res.canceled ? [] : res.filePaths.slice(0, 4);
    },
    async studyStyle({ at, ids = [], files = [] }) {
      const found = trendsData().searches.find((s) => s.at === at) ?? { topic: "referências", days: null, format: "all", videos: [], insights: { terms: [], duration: {}, titles: {}, timing: { days: Array(7).fill(0), hours: Array(24).fill(0) }, outliers: 0 } };
      if (running.has("trends")) throw new Error("Já estou estudando um estilo; espere terminar.");
      const controller = new AbortController();
      running.set("trends", { agent: "research", controller, resource: "llm" });
      changed();
      try {
        const ctx = context({ agentId: "research", signal: controller.signal });
        let mine = [];
        if (youtube.status().connected) mine = await youtube.myUploads(20).catch(() => []);
        const style = await trends.study(ctx, {
          found,
          ids,
          files: files.filter((f) => fs.existsSync(f)),
          mine,
          transcribe: (params) => {
            const stop = () => ai.cancel();
            controller.signal.addEventListener("abort", stop);
            return ai.run("transcribeFile", params, () => {}).finally(() => controller.signal.removeEventListener("abort", stop));
          },
        });
        saveTrends({ styles: [style, ...trendsData().styles].slice(0, 30) });
        lastError.delete("research");
        return style;
      } catch (err) {
        if (!controller.signal.aborted) {
          db.log({ agent: "research", level: "error", message: `Tendências: ${err.message}` });
          lastError.set("research", err.message);
        }
        throw err;
      } finally {
        running.delete("trends");
        changed();
      }
    },
    cancelStudy() {
      running.get("trends")?.controller.abort();
    },
    studying: () => running.has("trends"),
    /** The style the editor's assistant and the Edit and Script agents follow (null: none). */
    setActiveStyle(id) {
      saveTrends({ active: id && trendsData().styles.some((s) => s.id === id) ? id : null });
      changed();
      return activeStyle() ? { id: activeStyle().id, name: activeStyle().name } : null;
    },
    activeStyle: () => (activeStyle() ? { id: activeStyle().id, name: activeStyle().name, topic: activeStyle().topic } : null),
    renameStyle(id, name) {
      saveTrends({ styles: trendsData().styles.map((s) => (s.id === id ? { ...s, name: String(name).slice(0, 60) || s.name } : s)) });
    },
    deleteStyle(id) {
      const t = trendsData();
      saveTrends({ styles: t.styles.filter((s) => s.id !== id), active: t.active === id ? null : t.active });
      changed();
    },
    /** An idea of a style becomes a script, with the style as its research. */
    scriptFromIdea(styleId, index) {
      const style = trendsData().styles.find((s) => s.id === styleId);
      const idea = style?.ideas[index];
      if (!idea) throw new Error("Ideia não encontrada.");
      const id = db.addScript({ topic: idea.title, tone: style.script.tone || "natural", durationTarget: idea.format === "short" ? 45 : 480, format: idea.format });
      db.updateScript(id, { research: trends.asResearch(style, idea) });
      db.log({ scriptId: id, agent: "script", message: `Roteiro pedido a partir de uma ideia do estilo "${style.name}".` });
      changed();
      tick();
      return id;
    },
    /** Opens the editor with the assistant ready to edit the open project in this style (the creator sends it). */
    applyStyleInEditor(id) {
      const style = trendsData().styles.find((s) => s.id === id);
      if (!style) throw new Error("Estilo não encontrado.");
      saveTrends({ active: id });
      changed();
      const win = openEditor();
      const text = `Edite o projeto aberto no estilo "${style.name}" (o guia de estilo ativo): siga as regras de edição dele — ritmo dos cortes, legendas, zooms, sons e textos. Antes de mudar, me diga em poucas linhas o que vai fazer.`;
      const send = () => win.webContents.send("chat:prefill", text);
      if (win.webContents.isLoading()) win.webContents.once("did-finish-load", () => setTimeout(send, 800));
      else send();
    },
    stylePromptForEditor: () => trends.stylePrompt(activeStyle()),

    createScript({ topic, tone, durationTarget, format }) {
      if (!String(topic ?? "").trim()) throw new Error("Informe o tema.");
      const id = db.addScript({ topic: String(topic).trim(), tone: String(tone || "natural").trim(), durationTarget: Math.max(15, Math.round(Number(durationTarget) || 480)), format: format === "short" ? "short" : "long" });
      db.log({ scriptId: id, agent: "script", message: "Roteiro pedido." });
      changed();
      tick();
      return id;
    },
    adjustScript(id, instruction) {
      if (!String(instruction ?? "").trim()) return;
      db.updateScript(id, { status: "queued", pending_instruction: String(instruction).trim() });
      changed();
      tick();
    },
    saveScript(id, content) {
      const row = db.script(id);
      if (!row) return;
      const next = { ...row.content, ...content };
      next.estimated_seconds = Math.round((script.countWords(script.teleprompterText(next, next.hook)) / (voice().wpm || script.WORDS_PER_MINUTE)) * 60);
      db.saveScriptVersion(id, next, "Editado por você");
      // An approved script that changes has to be approved again.
      if (row.status === "approved") db.updateScript(id, { status: "review" });
      changed();
    },
    chooseHook(id, index) {
      const row = db.script(id);
      if (!row?.content) return;
      db.updateScript(id, { content: { ...row.content, hook: index } });
      changed();
    },
    approveScript(id) {
      db.updateScript(id, { status: "approved" });
      db.log({ scriptId: id, agent: "script", level: "decision", message: "Roteiro aprovado por você. Pronto para gravar." });
      changed();
    },
    rejectScript(id) {
      stopRunning((r) => r.scriptId === id);
      db.updateScript(id, { status: "rejected" });
      changed();
    },
    removeScript(id) {
      stopRunning((r) => r.scriptId === id);
      db.removeScript(id);
      changed();
    },
    scriptVersions: (id) => db.scriptVersions(id),
    restoreScript(id, version) {
      const content = db.scriptVersion(id, version);
      if (!content) return;
      db.saveScriptVersion(id, content, `Voltou à versão ${version}`);
      db.updateScript(id, { status: "review" });
      changed();
    },
    teleprompter(id) {
      const row = db.script(id);
      return row?.content ? { topic: row.topic, text: script.teleprompterText(row.content, row.content.hook), wpm: voice().wpm || script.WORDS_PER_MINUTE } : null;
    },
    /** Asked for by a click in Settings: the noise and echo remover, from its authors' releases page. */
    async installDeepFilter() {
      const release = await (await fetch("https://api.github.com/repos/Rikorose/DeepFilterNet/releases/latest", { headers: { "User-Agent": "Cena" } })).json();
      const asset = (release.assets ?? []).find((a) => /^deep-filter-.*x86_64-pc-windows-msvc\.exe$/.test(a.name));
      if (!asset) throw new Error("Não encontrei o instalador do DeepFilterNet para Windows.");
      const res = await fetch(asset.browser_download_url);
      if (!res.ok) throw new Error(`Falha ao baixar (HTTP ${res.status}).`);
      fs.mkdirSync(path.dirname(deepFilterExe), { recursive: true });
      fs.writeFileSync(`${deepFilterExe}.part`, Buffer.from(await res.arrayBuffer()));
      fs.renameSync(`${deepFilterExe}.part`, deepFilterExe);
      changed();
      return { name: asset.name, size: asset.size };
    },
  };

  const watcher = createWatcher((file) => {
    const added = addVideos([file]);
    if (added.length) notify("Vídeo novo na pasta monitorada", path.basename(file));
  });
  watcher.apply(settings().watch);

  // --- Windows, tray and quitting ----------------------------------------------------------------------
  /** Opens (or brings up) the studio panel; `tab` picks the tab it shows. */
  function openStudio(tab = null) {
    if (studioWindow && !studioWindow.isDestroyed()) {
      if (studioWindow.isMinimized()) studioWindow.restore();
      studioWindow.show();
      studioWindow.focus();
      if (tab) studioWindow.webContents.send("studio:tab", tab);
      return studioWindow;
    }
    studioWindow = new BrowserWindow({
      width: 1380,
      height: 880,
      minWidth: 1000,
      minHeight: 640,
      backgroundColor: "#141417",
      title: "Cena Estúdio",
      autoHideMenuBar: true,
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false, additionalArguments: ["--studio"] },
    });
    loadWindow(studioWindow, "estudio");
    if (tab) studioWindow.webContents.once("did-finish-load", () => setTimeout(() => studioWindow?.webContents.send("studio:tab", tab), 600));
    studioWindow.on("closed", () => {
      studioWindow = null;
      windowClosed();
    });
    ensureTray();
    return studioWindow;
  }

  /** Work in progress or a watched folder keeps the studio alive in the tray after its windows close. */
  const keepAlive = () => running.size > 0 || settings().watch.enabled || db.videos().some((v) => v.status === "queued" || ["queued", "waiting"].includes(v.data.publish?.status));

  function ensureTray() {
    if (tray || smoke) return;
    void app.getFileIcon(process.execPath, { size: "small" }).then((icon) => {
      if (tray || quitting) return;
      tray = new Tray(icon);
      tray.setToolTip("Cena Estúdio");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "Abrir o Estúdio", click: () => openStudio() },
          { label: "Abrir o Editor", click: () => openEditor() },
          { type: "separator" },
          { label: "Sair", click: () => app.quit() },
        ]),
      );
      tray.on("click", () => openStudio());
    });
  }

  /** Called when a window the user can see closes. The hidden worker never counts as "open". */
  function windowClosed() {
    const visible = BrowserWindow.getAllWindows().filter((w) => !isDesk(w) && !w.isDestroyed());
    if (visible.length) return;
    if (keepAlive() && !quitting) {
      ensureTray();
      notify("O Cena Estúdio continua trabalhando", "Ele fica no canto da barra de tarefas. Clique no ícone para abrir.");
    } else app.quit();
  }

  function dispose() {
    quitting = true;
    clearInterval(usageTimer);
    publisher.dispose();
    for (const entry of running.values()) entry.controller.abort();
    watcher.close();
    llm.dispose();
    ai.dispose();
    tray?.destroy();
    for (const d of desks) if (d.win && !d.win.isDestroyed()) d.win.destroy();
    try {
      db.close();
    } catch {
      // Already closed.
    }
  }

  setTimeout(tick, 1500);
  setTimeout(() => publisher.pump(), 4000);
  return { api, openStudio, windowClosed, dispose, isWorker: isDesk, approvals };
}

module.exports = { createStudio };

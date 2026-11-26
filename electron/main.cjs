const { app, BrowserWindow, dialog, ipcMain, protocol, session, shell } = require("electron");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const media = require("./media.cjs");
const ai = require("./ai.cjs");
const library = require("./library.cjs");
const fonts = require("./fonts.cjs");
const crypto = require("node:crypto");
const { registerAgent } = require("./mcp.cjs");
const { createChat } = require("./chat.cjs");
const { createMemory } = require("./memory.cjs");
const { createRecents } = require("./recents.cjs");
const { createAutosave, durableWrite } = require("./autosave.cjs");
const { createStudio } = require("./studio/index.cjs");

const SMOKE = process.argv.includes("--smoke");
/**
 * "Estúdio" clicked in a Cena that is only an editor (another Cena already runs the studio, maybe from the tray):
 * a copy is started with this flag; if the studio runs elsewhere, that Cena opens its studio window and this copy
 * ends at once. If it runs nowhere, this copy becomes the studio and opens it.
 */
const OPEN_STUDIO = process.argv.includes("--abrir-estudio");
if (OPEN_STUDIO && !SMOKE && !app.requestSingleInstanceLock()) app.exit(0);
const SMOKE_AI = SMOKE && process.env.CENA_SMOKE_AI === "1";
const DEV_URL = process.env.VITE_DEV_SERVER_URL;

const MIME = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav", ".ogg": "audio/ogg", ".flac": "audio/flac",
  ".woff2": "font/woff2",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
};

protocol.registerSchemesAsPrivileged([
  { scheme: "media", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: true } },
]);

/** Serves local files as media://file/<encoded absolute path>, honoring Range so <video> can seek. */
async function serveMedia(request) {
  const file = decodeURIComponent(new URL(request.url).pathname.slice(1));
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return new Response("not found", { status: 404 });
  }
  const headers = {
    "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Access-Control-Allow-Origin": "*",
  };
  const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get("range") ?? "");
  if (!range) {
    return new Response(Readable.toWeb(fs.createReadStream(file)), {
      status: 200,
      headers: { ...headers, "Content-Length": String(stat.size) },
    });
  }
  const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
  if (start >= stat.size || start > end) {
    return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${stat.size}` } });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
    status: 206,
    headers: { ...headers, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${stat.size}` },
  });
}

/** The editor window; the studio has windows of its own. */
let editorWindow = null;
let studio = null;

/** The same page serves the editor, the studio panel and the studio's hidden worker; the hash says which. */
function loadWindow(win, hash) {
  if (DEV_URL) win.loadURL(hash ? `${DEV_URL}#${hash}` : DEV_URL);
  else win.loadFile(path.join(__dirname, "..", "dist", "index.html"), hash ? { hash } : undefined);
}

function openEditor() {
  if (editorWindow && !editorWindow.isDestroyed()) {
    if (editorWindow.isMinimized()) editorWindow.restore();
    editorWindow.show();
    editorWindow.focus();
  } else createWindow();
  return editorWindow;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#141417",
    title: "Cena",
    show: !SMOKE,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: !SMOKE,
      additionalArguments: SMOKE ? ["--smoke"] : [],
    },
  });
  loadWindow(win, "");
  editorWindow = win;
  win.on("closed", () => {
    if (editorWindow === win) editorWindow = null;
    studio?.windowClosed();
  });
  if (!SMOKE) guardClose(win);
  if (SMOKE) {
    win.webContents.on("console-message", (event) => console.log(`[renderer] ${event.message}`));
    win.webContents.on("render-process-gone", (_e, details) => {
      console.error("renderer gone", details);
      app.exit(3);
    });
  }
  return win;
}

/** What the window reports about the open project, for the close confirmation. */
const windowState = new WeakMap();

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(stateFile("ajustes.json"), "utf8"));
  } catch {
    return {};
  }
}
function writeSettings(patch) {
  const file = stateFile("ajustes.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...readSettings(), ...patch }, null, 2));
}

/**
 * Closing the window asks first: save, close without saving or cancel when there are unsaved changes,
 * and a plain "Fechar o Cena?" otherwise (that one can be turned off). An export in progress is mentioned.
 */
function guardClose(win) {
  let allowed = false;
  let asking = false;
  win.on("close", (event) => {
    if (allowed) return;
    event.preventDefault();
    if (asking) return;
    asking = true;
    const { dirty = false, name = "Projeto", exporting = false } = windowState.get(win.webContents) ?? {};
    const exportNote = exporting ? "\n\nUma exportação está em andamento e será cancelada." : "";
    const finish = () => {
      allowed = true;
      void autosave?.close();
      win.close();
    };
    const ask = dirty
      ? dialog
          .showMessageBox(win, {
            type: "warning",
            title: "Fechar o Cena",
            message: `Salvar as alterações em "${name}" antes de fechar?`,
            detail: `Se você não salvar, as alterações feitas desde o último salvamento serão perdidas.${exportNote}`,
            buttons: ["Salvar e fechar", "Fechar sem salvar", "Cancelar"],
            defaultId: 0,
            cancelId: 2,
            noLink: true,
          })
          .then(({ response }) => {
            if (response === 1) finish();
            // The window saves (it may ask where) and answers with app:closeNow when it worked.
            else if (response === 0) win.webContents.send("app:saveAndClose");
          })
      : readSettings().confirmClose === false
        ? Promise.resolve(finish())
        : dialog
            .showMessageBox(win, {
              type: "question",
              title: "Fechar o Cena",
              message: "Fechar o Cena?",
              detail: `Tudo está salvo.${exportNote}`,
              buttons: ["Fechar", "Cancelar"],
              defaultId: 0,
              cancelId: 1,
              noLink: true,
              checkboxLabel: "Não perguntar de novo quando estiver tudo salvo",
            })
            .then(({ response, checkboxChecked }) => {
              if (response !== 0) return;
              if (checkboxChecked) writeSettings({ confirmClose: false });
              finish();
            });
    void ask.finally(() => (asking = false));
  });
  windowState.set(win.webContents, { dirty: false, name: "Projeto", allow: () => ((allowed = true), void autosave?.close(), win.close()) });
}

const capcutDraftRoot = () => path.join(process.env.LOCALAPPDATA ?? os.homedir(), "CapCut", "User Data", "Projects", "com.lveditor.draft");

let recents = null;
let autosave = null;
/** Settings files the self test may change live apart from the user's, so a test run never shows up in their lists. */
const stateFile = (name) => (SMOKE ? path.join(os.tmpdir(), "cena-smoke-state", name) : path.join(app.getPath("userData"), name));
let agent = null;
let chat = null;

/** A .cena file passed on the command line (double-click via the installer's file association). */
const launchProject = process.argv.slice(1).find((a) => a.toLowerCase().endsWith(".cena") && fs.existsSync(a)) ?? null;

function registerIpc() {
  recents = createRecents(stateFile("recentes.json"), { thumbnail: media.thumbnail });
  autosave = createAutosave(stateFile("autosave"));
  ipcMain.handle("autosave:write", (_e, project, projectPath) => autosave.write(project, projectPath));
  ipcMain.handle("autosave:clear", () => autosave.clear());
  ipcMain.handle("autosave:list", () => autosave.list());
  ipcMain.handle("autosave:read", (_e, id) => autosave.read(id));
  ipcMain.handle("autosave:discard", (_e, id) => autosave.discard(id));
  ipcMain.on("app:state", (event, state) => {
    const current = windowState.get(event.sender);
    if (current) Object.assign(current, { dirty: Boolean(state?.dirty), name: String(state?.name ?? "Projeto") });
  });
  ipcMain.handle("app:closeNow", (event) => windowState.get(event.sender)?.allow());
  ipcMain.handle("projects:recent", () => recents.list());
  ipcMain.handle("projects:forget", (_e, file) => recents.remove(file));
  ipcMain.handle("projects:reveal", (_e, file) => shell.showItemInFolder(file));
  // Only the name inside the project changes; the .cena file keeps its place (the studio and the list find it there).
  ipcMain.handle("projects:rename", async (_e, file, name) => {
    const clean = String(name ?? "").replace(/[ -]+/g, " ").trim().slice(0, 120);
    if (!clean) throw new Error("O nome não pode ficar vazio.");
    const data = JSON.parse(await fsp.readFile(file, "utf8"));
    data.name = clean;
    const tmp = `${file}.renomeando`;
    await fsp.writeFile(tmp, JSON.stringify(data));
    await fsp.rename(tmp, file);
    return clean;
  });
  ipcMain.handle("project:initial", async () => {
    if (!launchProject) return null;
    const data = JSON.parse(await fsp.readFile(launchProject, "utf8"));
    recents.touch(launchProject);
    return { path: launchProject, data };
  });
  ipcMain.handle("dialog:openMedia", async (event) => {
    const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: "Importar mídia",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Mídia", extensions: ["mp4", "mov", "m4v", "webm", "mkv", "mp3", "wav", "m4a", "aac", "ogg", "flac", "png", "jpg", "jpeg", "webp", "gif", "bmp"] },
        { name: "Todos os arquivos", extensions: ["*"] },
      ],
    });
    return res.canceled ? [] : res.filePaths;
  });
  ipcMain.handle("media:probe", (_e, file) => media.probe(file));
  ipcMain.handle("media:thumbnail", (_e, file, at) => media.thumbnail(file, at));
  ipcMain.handle("media:waveform", (_e, file) => media.waveform(file));
  ipcMain.handle("media:audioTracks", (_e, file) => media.extractAudioTracks(file, path.join(app.getPath("userData"), "processed")));
  ipcMain.handle("media:envelope", (_e, file, sourceStart, sourceDuration, hop) => media.envelope(file, sourceStart, sourceDuration, hop));
  ipcMain.handle("media:scenes", (_e, file, sourceStart, sourceDuration, threshold) => media.sceneChanges(file, sourceStart, sourceDuration, threshold));

  ipcMain.handle("project:open", async (event) => {
    const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: "Abrir projeto",
      filters: [{ name: "Projeto Cena", extensions: ["cena"] }],
      properties: ["openFile"],
    });
    if (res.canceled) return null;
    const data = JSON.parse(await fsp.readFile(res.filePaths[0], "utf8"));
    recents.touch(res.filePaths[0]);
    return { path: res.filePaths[0], data };
  });
  ipcMain.handle("project:save", async (event, project, currentPath) => {
    let target = currentPath;
    if (!target) {
      const res = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
        title: "Salvar projeto",
        defaultPath: `${project.name || "projeto"}.cena`,
        filters: [{ name: "Projeto Cena", extensions: ["cena"] }],
      });
      if (res.canceled || !res.filePath) return null;
      target = res.filePath;
    }
    const tmp = `${target}.tmp`;
    // Flushed before it replaces the old file: a power cut never leaves an empty project.
    await durableWrite(tmp, JSON.stringify(project, null, 2));
    await fsp.rename(tmp, target);
    recents.touch(target);
    return target;
  });

  // Used by the AI connection, which names files itself instead of going through a dialog.
  ipcMain.handle("project:read", async (_e, file) => {
    const data = JSON.parse(await fsp.readFile(file, "utf8"));
    recents.touch(file);
    return { path: file, data };
  });
  ipcMain.handle("fs:exists", (_e, file) => fs.existsSync(file));

  ipcMain.handle("capcut:listDrafts", async () => {
    const root = capcutDraftRoot();
    let entries = [];
    try {
      entries = await fsp.readdir(root, { withFileTypes: true });
    } catch {
      return { root, drafts: [] };
    }
    const drafts = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      const content = path.join(dir, "draft_content.json");
      try {
        const stat = await fsp.stat(content);
        const cover = path.join(dir, "draft_cover.jpg");
        drafts.push({
          name: entry.name,
          dir,
          modified: stat.mtimeMs,
          size: stat.size,
          cover: fs.existsSync(cover) ? cover : null,
        });
      } catch {
        // Not a draft folder.
      }
    }
    drafts.sort((a, b) => b.modified - a.modified);
    return { root, drafts };
  });
  ipcMain.handle("capcut:readDraft", async (_e, dir) => {
    const text = await fsp.readFile(path.join(dir, "draft_content.json"), "utf8");
    return { dir, data: JSON.parse(text.replace(/^﻿/, "")) };
  });

  ipcMain.handle("export:choosePath", async (event, name, ext = "mp4", label = "MP4") => {
    const res = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
      title: "Exportar",
      defaultPath: path.join(app.getPath("videos"), `${name || "video"}.${ext}`),
      filters: [{ name: label, extensions: [ext] }],
    });
    return res.canceled ? null : res.filePath;
  });
  // A ready-to-use file in Videos, so Export works without picking one: "Name.mp4", then "Name (2).mp4"…
  ipcMain.handle("export:defaultPath", (_e, name, ext = "mp4", folder = null) => {
    const base = String(name || "video").replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim() || "video";
    const dir = folder ?? app.getPath("videos");
    for (let n = 1; ; n++) {
      const file = path.join(dir, `${base}${n > 1 ? ` (${n})` : ""}.${ext}`);
      if (!fs.existsSync(file)) return file;
    }
  });
  // Encoding and decoding run in the preload: 8 MB frames through IPC took more time than the video work itself.
  ipcMain.on("app:exporting", (event, exporting) => {
    const current = windowState.get(event.sender);
    if (current) current.exporting = Boolean(exporting);
  });
  ipcMain.handle("shell:reveal", (_e, file) => shell.showItemInFolder(file));
  // Full-resolution still of a video frame, for freeze frames.
  ipcMain.handle("media:frame", async (_e, file, seconds) => {
    const dir = path.join(app.getPath("userData"), "processed");
    await fsp.mkdir(dir, { recursive: true });
    const out = path.join(dir, `frame-${crypto.randomUUID()}.png`);
    await media.run(media.FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(Math.max(0, seconds)), "-i", file, "-frames:v", "1", out]);
    return out;
  });
  // Voiceover recorded in the renderer (MediaRecorder bytes).
  ipcMain.handle("recording:save", async (_e, bytes, ext) => {
    const dir = path.join(app.getPath("userData"), "recordings");
    await fsp.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const out = path.join(dir, `narracao-${stamp}.${/^(webm|ogg|wav)$/.test(ext) ? ext : "webm"}`);
    await fsp.writeFile(out, Buffer.from(bytes));
    // The browser's recorder writes WebM without its length, so the clip came in a few frames long and silent.
    // A WAV copy has the real length; the WebM stays next to it as it was recorded.
    if (/.webm$/.test(out)) {
      const wav = out.replace(/.webm$/, ".wav");
      try {
        await media.run(media.FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", out, "-vn", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", wav]);
        if (fs.existsSync(wav) && fs.statSync(wav).size > 1000) return wav;
      } catch {
        // Keep the WebM if the conversion fails.
      }
    }
    return out;
  });
  // AI voice (Piper): downloaded only when the creator asks, then it speaks offline.
  const tts = require("./tts.cjs");
  ipcMain.handle("tts:status", () => tts.status());
  ipcMain.handle("tts:install", (e) => tts.install((progress, text) => !e.sender.isDestroyed() && e.sender.send("tts:progress", { progress, text })));
  ipcMain.handle("tts:speak", (_e, text, options) => tts.speak(text, options));
  const fontsDir = () => path.join(app.getPath("userData"), "fonts");
  ipcMain.handle("fonts:ensure", (_e, family) => fonts.ensureFont(family, fontsDir()));
  ipcMain.handle("fonts:catalog", () => fonts.catalog(fontsDir()));
  ipcMain.handle("fonts:custom", () => fonts.listCustom(fontsDir()));
  ipcMain.handle("fonts:import", async (event) => {
    const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: "Importar fontes",
      filters: [{ name: "Fontes", extensions: ["ttf", "otf", "woff", "woff2"] }],
      properties: ["openFile", "multiSelections"],
    });
    if (res.canceled) return null;
    return fonts.importFonts(res.filePaths, fontsDir());
  });
  ipcMain.handle("subtitles:open", async (event) => {
    const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: "Importar legendas",
      filters: [{ name: "Legendas", extensions: ["srt", "ass", "ssa"] }],
      properties: ["openFile"],
    });
    if (res.canceled) return null;
    const file = res.filePaths[0];
    return { name: path.basename(file), text: (await fsp.readFile(file, "utf8")).replace(/^﻿/, "") };
  });
  ipcMain.handle("subtitles:save", async (event, name, text) => {
    const res = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
      title: "Exportar legendas",
      defaultPath: path.join(app.getPath("videos"), `${name || "legendas"}.srt`),
      filters: [{ name: "SubRip", extensions: ["srt"] }],
    });
    if (res.canceled || !res.filePath) return null;
    await fsp.writeFile(res.filePath, text, "utf8");
    return res.filePath;
  });
  ipcMain.handle("shell:openExternal", (_e, url) => {
    if (/^https:\/\//.test(url)) return shell.openExternal(url);
  });

  // AI tasks run in a utility process; results that are new media land in userData/processed.
  ipcMain.handle("ai:run", async (event, task, params) => {
    const outputs = {
      removeBackground: params.kind === "image" ? ".png" : ".webm",
      removeObjects: ".png",
      reverse: params.hasVideo ? ".mp4" : ".m4a",
      denoise: ".m4a",
      voice: ".m4a",
      enhance: ".mp4",
    };
    if (outputs[task]) {
      const dir = path.join(app.getPath("userData"), "processed");
      await fsp.mkdir(dir, { recursive: true });
      params = { ...params, outPath: path.join(dir, `${task}-${crypto.randomUUID()}${outputs[task]}`) };
    }
    return ai.run(task, params, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send("ai:progress", progress);
    });
  });
  ipcMain.handle("ai:cancel", () => ai.cancel());

  const libraryDir = () => path.join(app.getPath("userData"), "library");
  ipcMain.handle("library:search", (_e, params) => library.search(params));
  ipcMain.handle("library:download", (_e, item) => library.download(item, libraryDir()));
  ipcMain.handle("library:builtins", () => library.builtins(path.join(libraryDir(), "builtin")));

  // End-to-end self test: generate synthetic media, let the renderer build and export a project.
  ipcMain.handle("smoke:setup", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cena-smoke-"));
    const video = path.join(dir, "testsrc.mp4");
    const audio = path.join(dir, "tone.wav");
    await media.run(media.FFMPEG, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=3",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video,
    ]);
    await media.run(media.FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=660:duration=2", audio]);
    const image = path.join(dir, "photo.png");
    await media.run(media.FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=800x600", "-frames:v", "1", image]);
    // An OBS-style recording: a hard cut at 3 s, game sound on track 1, "voice" with a pause from 2 to 4 s on track 2.
    const ff = (...args) => media.run(media.FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
    const decodeSamples = {
      untaggedHd: path.join(dir, "hd.mp4"),
      taggedHd: path.join(dir, "hd709.mp4"),
      variableRate: path.join(dir, "vfr.mkv"),
      rotated: path.join(dir, "rotated.mp4"),
      transparent: path.join(dir, "alpha.webm"),
    };
    await ff("-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=2", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", decodeSamples.untaggedHd);
    await ff("-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=2", "-vf", "scale=out_color_matrix=bt709,format=yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-c:v", "libx264", "-preset", "ultrafast", decodeSamples.taggedHd);
    await ff("-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=2", "-vf", "select='not(mod(n,3))+gt(n,30)',setpts='if(lt(N,10),N*3/30,(N+20)/30)/TB'", "-fps_mode", "vfr", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", decodeSamples.variableRate);
    await ff("-display_rotation", "90", "-i", decodeSamples.untaggedHd, "-c", "copy", decodeSamples.rotated);
    await ff("-f", "lavfi", "-i", "color=c=red@0.0:size=320x180:rate=30:duration=1,format=yuva420p", "-c:v", "libvpx-vp9", "-auto-alt-ref", "0", decodeSamples.transparent);
    const obs = path.join(dir, "obs.mkv");
    await media.run(media.FFMPEG, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=3",
      "-f", "lavfi", "-i", "color=c=red:size=320x240:rate=30:duration=3",
      "-f", "lavfi", "-i", "sine=frequency=220:duration=6",
      "-f", "lavfi", "-i", "sine=frequency=700:duration=6",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v];[2:a]volume=0.25[game];[3:a]volume='if(between(t,2,4),0,0.8)':eval=frame[voice]",
      "-map", "[v]", "-map", "[game]", "-map", "[voice]",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", obs,
    ]);
    // A camera-style MOV whose extra track is 24-bit PCM: separated by copying into WAV.
    const pcm = path.join(dir, "pcm.mov");
    await media.run(media.FFMPEG, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=3",
      "-f", "lavfi", "-i", "sine=frequency=300:duration=3",
      "-f", "lavfi", "-i", "sine=frequency=500:duration=3",
      "-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "pcm_s24le", pcm,
    ]);
    // AI checks download models, so they only run when asked for (CENA_SMOKE_AI=1, optional speech sample).
    const aiChecks = SMOKE_AI ? { speech: process.env.CENA_SMOKE_SPEECH || null } : null;
    return { dir, video, audio, image, obs, pcm, decodeSamples, output: path.join(dir, "export.mp4"), ai: aiChecks };
  });
  ipcMain.handle("smoke:mcp", () => agent.smokeCheck());
  ipcMain.handle("smoke:done", async (_e, result) => {
    let verified = null;
    if (result.ok && result.output) {
      try {
        verified = await media.probe(result.output);
      } catch (err) {
        result.ok = false;
        result.error = `export unreadable: ${err.message}`;
      }
    }
    reportSmoke(`SMOKE_RESULT ${JSON.stringify({ ...result, verified })}`);
    setTimeout(() => app.exit(result.ok ? 0 : 1), 50);
  });
}

// The portable launcher does not forward stdout, so the smoke script can also ask for a file.
function reportSmoke(line) {
  console.log(line);
  if (process.env.CENA_SMOKE_OUT) fs.writeFileSync(process.env.CENA_SMOKE_OUT, line);
}

/**
 * The portable Cena.exe unpacks into a temporary folder named after its build. Folders left by older builds are
 * removed; one still in use cannot be renamed on Windows, so it is skipped and never half deleted.
 */
function removeOldPortableFolders() {
  const here = path.dirname(process.execPath);
  if (!/^Cena-Portatil/i.test(path.basename(here))) return;
  const parent = path.dirname(here);
  for (const name of fs.readdirSync(parent)) {
    if (!/^Cena-Portatil/i.test(name) || name === path.basename(here) || name.endsWith(".apagando")) continue;
    const doomed = path.join(parent, `${name}.apagando`);
    try {
      fs.renameSync(path.join(parent, name), doomed);
    } catch {
      continue;
    }
    fs.rm(doomed, { recursive: true, force: true }, () => {});
  }
  for (const name of fs.readdirSync(parent)) if (name.startsWith("Cena-Portatil") && name.endsWith(".apagando")) fs.rm(path.join(parent, name), { recursive: true, force: true }, () => {});
}

app.whenReady().then(() => {
  try {
    removeOldPortableFolders();
  } catch {
    // Cleaning up is never worth stopping the app for.
  }
  protocol.handle("media", serveMedia);
  // The font picker lists installed fonts through the Local Font Access API.
  // The microphone ("media") is used only by the voiceover recorder, which the user starts.
  const allowed = ["local-fonts", "clipboard-sanitized-write", "fullscreen", "media"];
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.includes(permission));
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.includes(permission)));
  registerIpc();
  agent = registerAgent({ app, ipcMain, BrowserWindow, editorWindow: () => (editorWindow && !editorWindow.isDestroyed() ? editorWindow : null) });
  // One studio per computer account: a second Cena opened beside this one is an editor only.
  if (!SMOKE && app.requestSingleInstanceLock()) {
    studio = createStudio({ agent, preload: path.join(__dirname, "preload.cjs"), loadWindow, openEditor });
    app.on("second-instance", (_e, argv) => {
      if (argv.includes("--abrir-estudio")) studio?.openStudio();
    });
    if (OPEN_STUDIO) setTimeout(() => studio?.openStudio(), 300);
  }
  ipcMain.handle("studio:available", () => Boolean(studio));
  ipcMain.handle("studio:open", (_e, tab) => {
    if (studio) return void studio.openStudio(typeof tab === "string" ? tab : null);
    // This Cena is an editor only: ask the Cena that runs the studio (or a new one) to show it.
    const { spawn } = require("node:child_process");
    const keep = process.argv.filter((a) => a.startsWith("--user-data-dir="));
    const args = [...(app.isPackaged ? [] : [app.getAppPath()]), ...keep, "--abrir-estudio"];
    spawn(process.execPath, args, { detached: true, stdio: "ignore", env: process.env }).unref();
  });
  ipcMain.handle("studio:call", (_e, method, args) => {
    const fn = studio?.api[method];
    if (typeof fn !== "function") throw new Error(`Estúdio: ação desconhecida (${method}).`);
    return fn(...(Array.isArray(args) ? args : []));
  });
  const memory = createMemory(stateFile("preferencias.json"), (items) => {
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send("memory:changed", items);
  });
  ipcMain.handle("memory:list", () => memory.list());
  ipcMain.handle("memory:add", (_e, text) => memory.add(text));
  ipcMain.handle("memory:update", (_e, id, text) => memory.update(id, text));
  ipcMain.handle("memory:remove", (_e, ids) => memory.remove(ids));
  ipcMain.handle("memory:clear", () => memory.clear());
  // What the assistant knows of the creator: their preferences and, when one is on, the style studied in Trends.
  const chatPreferences = () => {
    const style = studio?.api.stylePromptForEditor() ?? "";
    const note = 'When the creator asks to edit "in the style" (or "no estilo") without naming one, follow this guide; otherwise use it only when it helps.';
    return memory.prompt() + (style ? `\n\n${style}\n${note}` : "");
  };
  // Folders the user opened to the assistant (memes, sounds…): it may read and edit files there.
  const foldersFile = stateFile("pastas-da-ia.json");
  const readFolders = () => {
    try {
      const list = JSON.parse(fs.readFileSync(foldersFile, "utf8"));
      return Array.isArray(list) ? list.filter((f) => typeof f === "string") : [];
    } catch {
      return [];
    }
  };
  const writeFolders = (list) => {
    fs.mkdirSync(path.dirname(foldersFile), { recursive: true });
    fs.writeFileSync(foldersFile, JSON.stringify(list, null, 2));
    return list;
  };
  ipcMain.handle("aiFolders:list", () => readFolders());
  ipcMain.handle("aiFolders:add", async (event) => {
    const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { title: "Pasta que a IA pode usar", properties: ["openDirectory"] });
    if (res.canceled || !res.filePaths[0]) return readFolders();
    const list = readFolders();
    const folder = path.resolve(res.filePaths[0]);
    if (!list.some((f) => f.toLowerCase() === folder.toLowerCase())) list.push(folder);
    return writeFolders(list);
  });
  ipcMain.handle("aiFolders:remove", (_e, folder) => writeFolders(readFolders().filter((f) => f !== folder)));
  chat = createChat({ workspace: path.join(app.getPath("userData"), "assistente"), endpoint: agent.internalEndpoint, preferences: chatPreferences, folders: readFolders });
  ipcMain.handle("chat:status", () => chat.status());
  ipcMain.handle("chat:send", (event, request) => chat.send(request, (e) => !event.sender.isDestroyed() && event.sender.send("chat:event", e)));
  ipcMain.handle("chat:cancel", () => chat.cancel());
  // A copy started only to show the studio does not open another editor.
  if (!(OPEN_STUDIO && studio)) createWindow();
  // The self test must not take the port of a Cena the user has open.
  if (!SMOKE) void agent.start();
  if (SMOKE) setTimeout(() => {
    reportSmoke("SMOKE_RESULT {\"ok\":false,\"error\":\"timeout\"}");
    app.exit(2);
  }, SMOKE_AI ? 1_200_000 : 120_000);
});

// With the studio, its own check decides: it may stay in the tray while there is work to do.
app.on("window-all-closed", () => (studio ? studio.windowClosed() : app.quit()));
app.on("will-quit", () => {
  ai.dispose();
  studio?.dispose();
  chat?.cancel();
  void agent?.dispose();
});

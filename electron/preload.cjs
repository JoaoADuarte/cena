const { contextBridge, ipcRenderer, webUtils } = require("electron");
const { ExportSession, gpuEncoders, gpuLabels } = require("./exporter.cjs");
const { createFrameReaders } = require("./frameReader.cjs");
const { HybridExport } = require("./hybrid.cjs");

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

// Frames stay in this process, and go through canvases: this script and the page share the DOM, while
// passing a 1080p frame across the context bridge cost more than decoding it.
const canvasContext = (id) => document.getElementById(id).getContext("2d", { willReadFrequently: true });

const frameReaders = createFrameReaders();
let exportSession = null;
let hybrid = null;
const setExporting = (exporting) => ipcRenderer.send("app:exporting", exporting);

const stopAll = () => {
  exportSession?.cancel();
  exportSession = null;
  hybrid?.cancel();
  hybrid = null;
  frameReaders.closeAll();
};
window.addEventListener("unload", stopAll);

const videoExport = {
  exportGpu: () => gpuLabels(),
  async exportStart(job) {
    exportSession?.cancel();
    exportSession = null;
    const format = job.format ?? "h264";
    const gpu = job.gpu && ["h264", "hevc", "av1"].includes(format) ? (await gpuEncoders())[format] : null;
    exportSession = new ExportSession(job, gpu);
    setExporting(true);
    return true;
  },
  /** Encode what is on this canvas (it has to be in the document). */
  async exportCanvasFrame(canvasId) {
    if (!exportSession) throw new Error("Nenhuma exportação em andamento.");
    const canvas = document.getElementById(canvasId);
    const pixels = canvasContext(canvasId).getImageData(0, 0, canvas.width, canvas.height).data;
    await exportSession.writeFrame(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
  },
  async exportFinish() {
    const session = exportSession;
    exportSession = null;
    if (!session) throw new Error("Nenhuma exportação em andamento.");
    try {
      return await session.finish();
    } finally {
      setExporting(false);
    }
  },
  async exportCancel() {
    stopAll();
    setExporting(false);
  },
  async hybridStart(job, pieces) {
    stopAll();
    const gpu = job.gpu ? (await gpuEncoders())[job.format] : null;
    hybrid = new HybridExport(job, gpu, pieces);
    setExporting(true);
  },
  hybridProgress: async () => hybrid?.framesDone() ?? 0,
  /** Direct pieces that have to be redone by the compositor. */
  hybridDirectDone: () => hybrid.directDone,
  hybridBeginRender(index) {
    hybrid.beginRender(index);
  },
  async hybridCanvasFrame(canvasId) {
    const canvas = document.getElementById(canvasId);
    const pixels = canvasContext(canvasId).getImageData(0, 0, canvas.width, canvas.height).data;
    await hybrid.writeFrame(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
  },
  hybridBeginOverlay: (index, box) => hybrid.beginOverlay(index, box),
  async hybridOverlayFrame(canvasId, box) {
    const pixels = canvasContext(canvasId).getImageData(box.x, box.y, box.width, box.height).data;
    await hybrid.writeFrame(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
  },
  hybridDropRender: (index) => hybrid.dropRender(index),
  hybridEndRender: () => hybrid.endRender(),
  async hybridFinish() {
    const session = hybrid;
    try {
      return await session.finish();
    } finally {
      hybrid = null;
      setExporting(false);
    }
  },
  decodeOpen: (file, seconds) => frameReaders.open(file, seconds),
  /** Put the frame on screen at `seconds` on this canvas; null to fall back to seeking. */
  async decodeFrameTo(id, seconds, canvasId) {
    const frame = await frameReaders.frame(id, seconds);
    if (!frame) return null;
    const canvas = document.getElementById(canvasId);
    if (canvas.width !== frame.width || canvas.height !== frame.height) {
      canvas.width = frame.width;
      canvas.height = frame.height;
    }
    const pixels = new Uint8ClampedArray(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
    canvasContext(canvasId).putImageData(new ImageData(pixels, frame.width, frame.height), 0, 0);
    return { width: frame.width, height: frame.height };
  },
  async decodeClose(id) {
    frameReaders.close(id);
  },
};

contextBridge.exposeInMainWorld("api", {
  ...videoExport,
  smoke: process.argv.includes("--smoke"),
  isStudio: process.argv.includes("--studio"),
  isWorker: process.argv.includes("--studio-worker"),
  studioAvailable: invoke("studio:available"),
  openStudio: invoke("studio:open"),
  studioCall: (method, ...args) => ipcRenderer.invoke("studio:call", method, args),
  /** The studio asks the editor's assistant to start a request (the creator still sends it). */
  onChatPrefill: (callback) => {
    const listener = (_e, text) => callback(text);
    ipcRenderer.on("chat:prefill", listener);
    return () => ipcRenderer.off("chat:prefill", listener);
  },
  onStudioTab: (callback) => {
    const listener = (_e, tab) => callback(tab);
    ipcRenderer.on("studio:tab", listener);
    return () => ipcRenderer.off("studio:tab", listener);
  },
  onStudioChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("studio:changed", listener);
    return () => ipcRenderer.off("studio:changed", listener);
  },
  onStudioSystem: (callback) => {
    const listener = (_e, system) => callback(system);
    ipcRenderer.on("studio:system", listener);
    return () => ipcRenderer.off("studio:system", listener);
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
  openMediaDialog: invoke("dialog:openMedia"),
  probe: invoke("media:probe"),
  thumbnail: invoke("media:thumbnail"),
  waveform: invoke("media:waveform"),
  extractAudioTracks: invoke("media:audioTracks"),
  audioEnvelope: invoke("media:envelope"),
  sceneChanges: invoke("media:scenes"),
  openProject: invoke("project:open"),
  initialProject: invoke("project:initial"),
  saveProject: invoke("project:save"),
  listCapcutDrafts: invoke("capcut:listDrafts"),
  readCapcutDraft: invoke("capcut:readDraft"),
  chooseExportPath: invoke("export:choosePath"),
  defaultExportPath: invoke("export:defaultPath"),
  revealFile: invoke("shell:reveal"),
  openExternal: invoke("shell:openExternal"),
  extractFrame: invoke("media:frame"),
  saveRecording: invoke("recording:save"),
  ttsStatus: invoke("tts:status"),
  ttsInstall: invoke("tts:install"),
  ttsSpeak: invoke("tts:speak"),
  onTtsProgress: (callback) => {
    const listener = (_e, progress) => callback(progress);
    ipcRenderer.on("tts:progress", listener);
    return () => ipcRenderer.off("tts:progress", listener);
  },
  openSubtitles: invoke("subtitles:open"),
  saveSubtitles: invoke("subtitles:save"),
  ensureFont: invoke("fonts:ensure"),
  googleFontsCatalog: invoke("fonts:catalog"),
  customFonts: invoke("fonts:custom"),
  importFonts: invoke("fonts:import"),
  aiRun: invoke("ai:run"),
  aiCancel: invoke("ai:cancel"),
  onAiProgress: (callback) => {
    const listener = (_e, progress) => callback(progress);
    ipcRenderer.on("ai:progress", listener);
    return () => ipcRenderer.off("ai:progress", listener);
  },
  librarySearch: invoke("library:search"),
  libraryDownload: invoke("library:download"),
  libraryBuiltins: invoke("library:builtins"),
  readProject: invoke("project:read"),
  fileExists: invoke("fs:exists"),
  agentState: invoke("agent:state"),
  agentConfigure: invoke("agent:configure"),
  agentRegisterTools: invoke("agent:tools"),
  agentReply: (reply) => ipcRenderer.send("agent:result", reply),
  onAgentCall: (callback) => {
    const listener = (_e, call) => callback(call);
    ipcRenderer.on("agent:call", listener);
    return () => ipcRenderer.off("agent:call", listener);
  },
  onAgentState: (callback) => {
    const listener = (_e, state) => callback(state);
    ipcRenderer.on("agent:state", listener);
    return () => ipcRenderer.off("agent:state", listener);
  },
  chatStatus: invoke("chat:status"),
  chatSend: invoke("chat:send"),
  chatCancel: invoke("chat:cancel"),
  onChatEvent: (callback) => {
    const listener = (_e, event) => callback(event);
    ipcRenderer.on("chat:event", listener);
    return () => ipcRenderer.off("chat:event", listener);
  },
  reportState: (state) => ipcRenderer.send("app:state", state),
  closeNow: invoke("app:closeNow"),
  onSaveAndClose: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("app:saveAndClose", listener);
    return () => ipcRenderer.off("app:saveAndClose", listener);
  },
  autosaveWrite: invoke("autosave:write"),
  autosaveClear: invoke("autosave:clear"),
  autosaveList: invoke("autosave:list"),
  autosaveRead: invoke("autosave:read"),
  autosaveDiscard: invoke("autosave:discard"),
  recentProjects: invoke("projects:recent"),
  forgetProject: invoke("projects:forget"),
  revealProject: invoke("projects:reveal"),
  renameProject: invoke("projects:rename"),
  memoryList: invoke("memory:list"),
  memoryAdd: invoke("memory:add"),
  memoryUpdate: invoke("memory:update"),
  memoryRemove: invoke("memory:remove"),
  memoryClear: invoke("memory:clear"),
  aiFoldersList: invoke("aiFolders:list"),
  aiFoldersAdd: invoke("aiFolders:add"),
  aiFoldersRemove: invoke("aiFolders:remove"),
  onMemoryChanged: (callback) => {
    const listener = (_e, items) => callback(items);
    ipcRenderer.on("memory:changed", listener);
    return () => ipcRenderer.off("memory:changed", listener);
  },
  smokeMcp: invoke("smoke:mcp"),
  smokeSetup: invoke("smoke:setup"),
  smokeDone: invoke("smoke:done"),
});

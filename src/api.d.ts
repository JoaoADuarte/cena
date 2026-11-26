import type { Micros, Project } from "./model/types";
import type { ExportFormatId, ExportQuality } from "./exportFormats";
import type { ExportPiece } from "./engine/exportPlan";

export interface ProbeResult {
  kind: "video" | "audio" | "image";
  name: string;
  path: string;
  duration: Micros;
  width?: number;
  height?: number;
  fps?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  /** How many audio tracks the file has (OBS can record game, microphone and chat apart). */
  audioTracks?: number;
}

export interface CapcutDraftEntry {
  name: string;
  dir: string;
  modified: number;
  size: number;
  cover: string | null;
}

export interface AudioClipJob {
  path: string;
  sourceStart: Micros;
  sourceDuration: Micros;
  start: Micros;
  duration: Micros;
  speed: number;
  volume: number;
  fadeIn: Micros;
  fadeOut: Micros;
  /** false: the speed change also shifts the pitch, like a tape. */
  keepPitch?: boolean;
  /** Volume automation (ducking…), seconds from the clip's start; replaces `volume` when present. Linear between points. */
  volumeKeyframes?: { time: number; value: number }[];
}

export interface ExportJob {
  outPath: string;
  width: number;
  height: number;
  fps: number;
  format: ExportFormatId;
  quality: ExportQuality;
  /** Use the graphics card's encoder when it has one for this format. */
  gpu?: boolean;
  duration: Micros;
  audio: AudioClipJob[];
  /** Bring the final mix to the platforms' loudness (-14 LUFS, as YouTube and Spotify use). */
  normalize?: boolean;
}

export interface AiProgress {
  stage: "download" | "prepare" | "work";
  label: string;
  loaded?: number;
  total?: number;
  done?: number;
}

export interface CaptionSegment {
  /** Seconds on the timeline clock. */
  start: number;
  end: number;
  text: string;
}

export interface AiTasks {
  transcribe: {
    params: { audio: AudioClipJob[]; duration: Micros; language: string | null; quality: "fast" | "accurate" | "max" };
    result: { segments: CaptionSegment[] };
  };
  removeBackground: {
    /** Times in seconds of source media. */
    params: { path: string; kind: "image" | "video"; width: number; height: number; fps: number; sourceStart: number; sourceDuration: number; hasAudio: boolean };
    result: { path: string; width: number; height: number };
  };
  removeObjects: {
    params: { path: string; maskPng: string };
    result: { path: string; width: number; height: number };
  };
  /** Plays the clip's source range backwards (video and/or audio). Times in seconds. */
  reverse: {
    params: { path: string; sourceStart: number; sourceDuration: number; hasVideo: boolean; hasAudio: boolean };
    result: { path: string };
  };
  /** Removes steady background noise (hiss, hum, fans) from the clip's audio. */
  denoise: {
    params: { path: string; sourceStart: number; sourceDuration: number };
    result: { path: string };
  };
  /** Commentary polish: noise, EQ, de-esser, compressor and speech loudness. */
  voice: {
    params: { path: string; sourceStart: number; sourceDuration: number };
    result: { path: string };
  };
  /** Cleans and sharpens the video, upscaling low resolutions 2× (up to 4K). */
  enhance: {
    params: { path: string; sourceStart: number; sourceDuration: number; width: number; height: number; hasAudio: boolean };
    result: { path: string; width: number; height: number };
  };
}

export interface LibraryItem {
  id: string;
  title: string;
  creator: string;
  license: string;
  needsCredit: boolean;
  licenseUrl: string | null;
  landingUrl: string | null;
  url: string;
  filetype: string | null;
  /** Seconds. */
  duration: number | null;
  source: string;
}

export interface CustomFont {
  family: string;
  weight: string;
  style: string;
  path: string;
}

export interface SmokeResult {
  ok: boolean;
  error?: string;
  output?: string;
  frames?: number;
  checks?: Record<string, unknown>;
}

/** The local MCP server that lets an AI client edit the project. */
export interface AgentServerState {
  enabled: boolean;
  running: boolean;
  port: number;
  token: string;
  url: string;
  error: string | null;
  /** Name and version of the last client that connected. */
  client: string | null;
}

/** MCP tool result content. */
export type AgentContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface AgentToolInfo {
  name: string;
  description: string;
  inputSchema: object;
}

/** Work left unsaved when Cena last ended abruptly. */
export interface RecoverableProject {
  id: string;
  name: string;
  /** The .cena it came from; null when it was never saved. */
  path: string | null;
  /** Epoch ms of the copy. */
  savedAt: number;
  /** Seconds. */
  duration: number;
  clips: number;
}

/** A project on the start screen. */
export interface RecentProject {
  path: string;
  name: string;
  /** Epoch ms when it was last opened or saved here. */
  opened: number;
  /** Epoch ms of the file's last change; null when the file is gone. */
  modified: number | null;
  /** Seconds. */
  duration: number;
  width: number | null;
  height: number | null;
  clips: number;
  /** JPEG data URL of its first picture. */
  cover: string | null;
  /** The file was moved or deleted. */
  missing: boolean;
}

/** A lasting editing preference the assistant remembers between conversations. */
export interface Preference {
  id: string;
  text: string;
  /** Epoch milliseconds. */
  created: number;
}

/** What the in-app assistant (headless Claude Code) is doing. */
export type ChatEvent =
  | { type: "start"; sessionId: string; model: string }
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; detail?: string | null }
  | { type: "result"; sessionId?: string; isError: boolean; text: string | null; denied: string[] };

export interface CenaApi {
  smoke: boolean;
  /** This window is the studio panel. */
  isStudio: boolean;
  /** This window is the studio's hidden worker: it builds and renders projects, and shows nothing. */
  isWorker: boolean;
  studioAvailable(): Promise<boolean>;
  openStudio(tab?: string): Promise<void>;
  onChatPrefill(callback: (text: string) => void): () => void;
  onStudioTab(callback: (tab: string) => void): () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  studioCall(method: string, ...args: unknown[]): Promise<any>;
  onStudioChanged(callback: () => void): () => void;
  onStudioSystem(callback: (system: { cpu: number; gpu: { name: string; load: number; memoryUsed: number; memoryTotal: number } | null }) => void): () => void;
  /** Where Claude Code was found (null: not installed) and the assistant's working folder. */
  chatStatus(): Promise<{ claude: string | null; workspace: string }>;
  /** Runs one request; events stream through onChatEvent and the final result is returned. */
  chatSend(request: { text: string; sessionId: string | null; model: string | null }): Promise<Extract<ChatEvent, { type: "result" }>>;
  chatCancel(): Promise<void>;
  onChatEvent(callback: (event: ChatEvent) => void): () => void;
  /** Read a project file by path, without a dialog. */
  readProject(path: string): Promise<{ path: string; data: Project }>;
  fileExists(path: string): Promise<boolean>;
  agentState(): Promise<AgentServerState>;
  agentConfigure(patch: { enabled?: boolean; port?: number; newToken?: boolean }): Promise<AgentServerState>;
  agentRegisterTools(tools: AgentToolInfo[]): Promise<void>;
  agentReply(reply: { id: string; ok: boolean; content?: AgentContent[]; error?: string }): void;
  onAgentCall(callback: (call: { id: string; name: string; args: Record<string, unknown> }) => void): () => void;
  onAgentState(callback: (state: AgentServerState) => void): () => void;
  /** Tell the window's close confirmation whether there are unsaved changes. */
  reportState(state: { dirty: boolean; name: string }): void;
  /** Close the window without asking (after "Salvar e fechar" saved the project). */
  closeNow(): Promise<void>;
  /** The user picked "Salvar e fechar" in the close confirmation. */
  onSaveAndClose(callback: () => void): () => void;
  /** Keep a recovery copy of the unsaved project, flushed to disk; returns when it was taken (null while closing). */
  autosaveWrite(project: Project, path: string | null): Promise<number | null>;
  autosaveClear(): Promise<void>;
  /** Copies left by a launch that ended without saving (power cut, crash). */
  autosaveList(): Promise<RecoverableProject[]>;
  autosaveRead(id: string): Promise<{ path: string | null; data: Project; savedAt: number }>;
  autosaveDiscard(id: string): Promise<void>;
  /** Projects opened or saved before, newest first, for the start screen. */
  recentProjects(): Promise<RecentProject[]>;
  forgetProject(path: string): Promise<void>;
  revealProject(path: string): Promise<void>;
  /** Changes the name saved inside a .cena file (the file itself stays where it is). Returns the name kept. */
  renameProject(path: string, name: string): Promise<string>;
  /** The assistant's saved editing preferences. */
  memoryList(): Promise<Preference[]>;
  memoryAdd(text: string): Promise<Preference[]>;
  memoryUpdate(id: string, text: string): Promise<Preference[]>;
  memoryRemove(ids: string | string[]): Promise<Preference[]>;
  memoryClear(): Promise<Preference[]>;
  /** Folders the assistant may read and edit (memes, sounds…). */
  aiFoldersList(): Promise<string[]>;
  /** Asks the user for a folder; returns the list after it. */
  aiFoldersAdd(): Promise<string[]>;
  aiFoldersRemove(folder: string): Promise<string[]>;
  onMemoryChanged(callback: (items: Preference[]) => void): () => void;
  smokeMcp(): Promise<Record<string, unknown>>;
  pathForFile(file: File): string;
  openMediaDialog(): Promise<string[]>;
  probe(path: string): Promise<ProbeResult>;
  thumbnail(path: string, atSeconds: number): Promise<string>;
  waveform(path: string): Promise<{ perSecond: number; peaks: number[] }>;
  /** Files for audio tracks 2..n of a recording (empty when it has one). */
  extractAudioTracks(path: string): Promise<string[]>;
  /** Loudness in dBFS every `hop` seconds over a source range (seconds). */
  audioEnvelope(path: string, sourceStart: number, sourceDuration: number, hop?: number): Promise<{ hop: number; db: number[] }>;
  /** Shot changes, in seconds into the source range. */
  sceneChanges(path: string, sourceStart: number, sourceDuration: number, threshold?: number): Promise<number[]>;
  openProject(): Promise<{ path: string; data: Project } | null>;
  initialProject(): Promise<{ path: string; data: Project } | null>;
  saveProject(project: Project, currentPath: string | null): Promise<string | null>;
  listCapcutDrafts(): Promise<{ root: string; drafts: CapcutDraftEntry[] }>;
  readCapcutDraft(dir: string): Promise<{ dir: string; data: unknown }>;
  chooseExportPath(name: string, ext?: string, label?: string): Promise<string | null>;
  /** An unused "<name>.<ext>" in `folder` (the Videos folder by default). */
  defaultExportPath(name: string, ext?: string, folder?: string | null): Promise<string>;
  /** Decode a video in order, from `seconds`; null when the browser has to render this file. */
  decodeOpen(path: string, seconds: number): Promise<string | null>;
  /** Draw the frame on screen at `seconds` (increasing) on a canvas in the document; null to fall back to seeking. */
  decodeFrameTo(id: string, seconds: number, canvasId: string): Promise<{ width: number; height: number } | null>;
  decodeClose(id: string): Promise<void>;
  /** Which graphics-card encoder works per codec on this computer (null: none). */
  exportGpu(): Promise<Record<"h264" | "hevc" | "av1", string | null>>;
  exportStart(job: ExportJob): Promise<boolean>;
  /** Export in pieces: direct ones start at once in the background. */
  hybridStart(job: ExportJob, pieces: ExportPiece[]): Promise<void>;
  /** Frames finished so far, across all pieces. */
  hybridProgress(): Promise<number>;
  /** Waits for the direct pieces; answers the ones the compositor has to redo. */
  hybridDirectDone(): Promise<number[]>;
  hybridBeginRender(index: number): Promise<void>;
  hybridCanvasFrame(canvasId: string): Promise<void>;
  /** A direct piece with texts on top: FFmpeg reads the video itself and takes only `box` of each frame from here. False: not possible for this footage. */
  hybridBeginOverlay(index: number, box: { x: number; y: number; width: number; height: number }): Promise<boolean>;
  hybridOverlayFrame(canvasId: string, box: { x: number; y: number; width: number; height: number }): Promise<void>;
  /** Forget a piece that failed half way, so it can be rendered again. */
  hybridDropRender(index: number): Promise<void>;
  hybridEndRender(): Promise<void>;
  /** Joins the pieces with the sound; answers the file. */
  hybridFinish(): Promise<string>;
  /** Encode what is on a canvas in the document. */
  exportCanvasFrame(canvasId: string): Promise<void>;
  exportFinish(): Promise<string>;
  exportCancel(): Promise<void>;
  revealFile(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  /** Full-resolution PNG of the frame at `seconds`; returns its path. */
  extractFrame(path: string, seconds: number): Promise<string>;
  /** Save recorded audio bytes; returns the file path. */
  saveRecording(bytes: Uint8Array, ext: string): Promise<string>;
  /** AI voice (Piper, offline once downloaded). */
  ttsStatus(): Promise<{ installed: boolean; voice: string; folder: string }>;
  ttsInstall(): Promise<{ installed: boolean; voice: string; folder: string }>;
  ttsSpeak(text: string, options?: { speed?: number; pause?: number }): Promise<string>;
  onTtsProgress(callback: (p: { progress: number; text: string }) => void): () => void;
  openSubtitles(): Promise<{ name: string; text: string } | null>;
  saveSubtitles(name: string, text: string): Promise<string | null>;
  /** Download a Google Font family (cached on disk); returns its local font files. */
  ensureFont(family: string): Promise<{ family: string; files: { path: string; weight: string; style: string; unicodeRange: string | null }[] }>;
  /** Google Fonts families with Latin support, most popular first (cached for a week). */
  googleFontsCatalog(): Promise<{ family: string; category: string; popularity: number }[]>;
  customFonts(): Promise<CustomFont[]>;
  /** Opens a file dialog; returns the updated list, or null when cancelled. */
  importFonts(): Promise<CustomFont[] | null>;
  aiRun<T extends keyof AiTasks>(task: T, params: AiTasks[T]["params"]): Promise<AiTasks[T]["result"]>;
  aiCancel(): Promise<void>;
  /** Returns an unsubscribe function. */
  onAiProgress(callback: (progress: AiProgress) => void): () => void;
  librarySearch(params: { query: string; category: "music" | "sound_effect"; page?: number; commercial: boolean }): Promise<{ total: number; pages: number; results: LibraryItem[] }>;
  libraryDownload(item: LibraryItem): Promise<string>;
  libraryBuiltins(): Promise<{ id: string; name: string; path: string }[]>;
  smokeSetup(): Promise<{ dir: string; video: string; audio: string; image: string; obs: string; pcm: string; decodeSamples: Record<"untaggedHd" | "taggedHd" | "variableRate" | "rotated" | "transparent", string>; output: string; ai: { speech: string | null } | null }>;
  smokeDone(result: SmokeResult): Promise<void>;
}

declare global {
  interface Window {
    api: CenaApi;
  }
}

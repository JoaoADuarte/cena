import { create } from "zustand";

export interface Cut {
  id: number;
  start: number;
  end: number;
  kind: string;
  reason: string;
  enabled: boolean;
}

export interface ShortIdea {
  id: number;
  start: number;
  end: number;
  title: string;
  reason: string;
  score: number;
  /** "prompt" when the creator asked for it in the Shorts tab. */
  source?: string;
  edited?: boolean;
  frame?: "square" | "fill" | "fit";
  focus?: number;
  captions?: boolean;
  hook?: string;
  tight?: boolean;
  /** A Story (Instagram, WhatsApp, TikTok) to tell people a video is out: posted by phone, never sent to YouTube. */
  story?: boolean;
  /** Where the character is across the frame (0–1), seen by the Shorts agent: the crop centres on it. */
  subject?: number;
  /** The vertical project built to change this Short in the editor. */
  editorProject?: string;
}

export interface EditItem {
  id: number;
  /** Seconds in the original recording. */
  time: number;
  enabled?: boolean;
  text?: string;
  seconds?: number;
  amount?: number;
  query?: string;
}

export interface EditPlan {
  zooms: EditItem[];
  texts: EditItem[];
  sections: EditItem[];
  broll: EditItem[];
  music: { query: string; mood?: string } | null;
  colour: { adjust: { brightness: number; contrast: number; saturation: number } } | null;
  stablePath: string | null;
  notes: string;
}

export interface EditSettings {
  intensity: "leve" | "media" | "intensa";
  captions: boolean;
  captionWords: number;
  captionPop: boolean;
  zooms: boolean;
  texts: boolean;
  transitions: boolean;
  transition: string;
  music: boolean;
  musicVolume: number;
  musicQuery: string;
  colour: boolean;
  broll: boolean;
  stabilize: boolean;
  font: string;
  textColour: string;
}

export interface Credit {
  kind: string;
  title: string;
  creator: string;
  license: string;
  needsCredit: boolean;
  url?: string | null;
}

export interface VideoMetadata {
  title: string;
  titles: string[];
  body: string;
  tags: string[];
  hashtags: string[];
  chapters: { time: number; title: string }[];
  useChapters: boolean;
  category: number;
  language: string;
  notes: string;
  manual?: boolean;
  chapterLines?: { time: number; title: string }[];
  description?: string;
}

export interface PublishState {
  status: "queued" | "uploading" | "waiting" | "stopped" | "error" | "done";
  progress?: number;
  error?: string | null;
  attempts?: number;
  nextTry?: number | null;
}

export interface YouTubeUpload {
  id: string;
  url: string;
  studio: string;
  uploadedAt: number;
  privacy: string;
  publishAt: number | null;
  title: string;
  thumbnail: boolean | string;
}

export interface YouTubeStatus {
  apiKey: boolean;
  client: boolean;
  clientId?: boolean;
  clientSecret?: boolean;
  clientEnd?: string | null;
  connected: boolean;
  channel: { id: string; title: string; thumb?: string | null } | null;
  quota: { day: string; units: number; searches: number; uploads: number; limits: { units: number; searches: number; uploads: number } };
  encrypted: boolean;
}

export interface StageState {
  name: string;
  status: "pending" | "running" | "done" | "error" | "skipped";
  progress: number;
  message: string | null;
  attempt: number;
}

export interface Part {
  id: number;
  title: string;
  start: number;
  end: number;
  reason: string;
}

export interface StudioVideo {
  id: number;
  title: string;
  source_path: string;
  /** "hold": stopped where the creator asked, waiting for "Continuar". */
  status: "queued" | "running" | "paused" | "hold" | "review" | "approved" | "rejected" | "error" | "divided";
  priority: number;
  /** The project of this video was saved in the editor after the studio built or rendered it. */
  projectChanged?: boolean;
  script_id: number | null;
  error: string | null;
  created_at: number;
  stages: StageState[];
  approval: { approved_at: number } | null;
  data: {
    duration?: number;
    width?: number;
    height?: number;
    fps?: number;
    thumb?: string | null;
    cuts?: Cut[];
    shorts?: ShortIdea[];
    summary?: string;
    missing?: string[];
    /** Measured on screen and in the game sound: one action value (0–1) every `every` seconds, and the strong and still stretches. */
    action?: { every: number; strip: number[]; action: { start: number; end: number }[]; still: { start: number; end: number }[] } | null;
    dirty?: boolean;
    /** Finished by the creator in the editor and sent with "Publicar": no agent changes it. */
    mine?: boolean;
    /** The editor project it came from. */
    editorProject?: string | null;
    finalPath?: string;
    projectPath?: string;
    finalDuration?: number;
    renderedAt?: number;
    edit?: EditPlan;
    editDone?: { zooms: number; texts: number; transitions: number; captions: number; broll: number; colour: boolean; music: { title: string; creator: string; license: string; needsCredit: boolean } | null };
    credits?: Credit[];
    overrides?: { edit?: Partial<EditSettings>; audio?: Record<string, unknown>; cut?: Record<string, unknown> };
    /** How the creator asked for this video to be edited, and after which stages the flow waits for them. */
    brief?: { text: string; stops: string[]; notes?: string | null; readAt?: number | null; split?: { count: number | null; rule: string } | null };
    /** Agents chosen for this video (null: all of them). */
    agents?: string[] | null;
    /** Sent from the editor: the creator's project, kept as it was. */
    fromEditor?: { path: string | null; copy: string; extras: number } | null;
    /** One recording, several videos: the parts the Director proposed, and the videos made from them. */
    parts?: Part[];
    partsReply?: string;
    children?: number[] | null;
    series?: { name: string } | null;
    partOf?: { parentId: number; index: number; count: number; start: number; end: number } | null;
    hold?: { after: string; at: number } | null;
    /** The project the studio opened in the editor for cutting by hand. */
    cutProject?: { path: string; builtAt: number } | null;
    thumbnails?: { path: string; text: string; layout: string; time: number; person: boolean; design?: ThumbDesign }[];
    thumbnail?: string;
    metadata?: VideoMetadata;
    schedule?: { at: number | null; privacy: string | null } | null;
    publish?: PublishState | null;
    youtube?: YouTubeUpload | null;
    /** A Short made from a moment of another video (parentId). It has no stages. */
    kind?: "short";
    parentId?: number;
    shortId?: number;
    cover?: string | null;
    render?: { progress: number; message: string | null } | null;
  };
}

export interface ScriptContent {
  titles: string[];
  hooks: string[];
  hook: number;
  body: string;
  retention: { at: string; text: string }[];
  cta: string;
  notes: string;
  estimated_seconds: number;
}

export interface StudioScript {
  id: number;
  topic: string;
  tone: string;
  duration_target: number;
  format: "long" | "short";
  status: "queued" | "researching" | "writing" | "review" | "approved" | "rejected" | "error";
  version: number;
  error: string | null;
  pending_instruction: string | null;
  content: ScriptContent | null;
  research: {
    summary?: string;
    confidence?: string;
    limits?: string;
    source?: "api" | "web";
    references?: { title: string; channel?: string; url?: string; views?: number | null; why_it_worked?: string; verified?: boolean; views_per_day?: number | null; views_per_subscriber?: number | null; engagement?: number | null; subscribers?: number | null }[];
    patterns?: Record<string, string | string[]>;
  } | null;
}

export interface AgentState {
  id: string;
  label: string;
  status: "idle" | "running" | "paused" | "error";
  jobs: number;
  error: string | null;
}

export interface StudioSettings {
  channel: { niche: string };
  models: Record<"research" | "script" | "cut" | "edit" | "metadata" | "thumbnail" | "review" | "shorts", string | null>;
  edit: EditSettings;
  thumbnail: { count: number };
  shorts: { frame: "square" | "fill" | "fit"; captions: boolean; auto: boolean; count: number; minScore: number; stories: boolean };
  publish: { privacy: "public" | "unlisted" | "private"; auto: boolean };
  cut: { style: "auto" | "falado" | "gameplay"; quality: "fast" | "accurate" | "max"; language: string; minPause: number; longQuiet: number; removeStill: boolean };
  audio: { preset: "auto" | "voz" | "misto" | "leve"; noise: number; deepFilter: boolean; tracks: string[]; gameLevel: number; chatLevel: number };
  render: { gpu: boolean; quality: "high" | "recommended" | "small" };
  voice: { learn: boolean };
  flow: { brief: string; stops: string[]; agents?: string[] | null };
  watch: { enabled: boolean; folder: string };
  notify: boolean;
  paused: boolean;
  agentsPaused: Record<string, boolean>;
  /** Videos worked on at the same time (1 to 3). */
  parallel: number;
}

export interface SystemLoad {
  cpu: number;
  gpu: { name: string; load: number; memoryUsed: number; memoryTotal: number } | null;
}

export interface StudioState {
  stages: { name: string; label: string; agent: string }[];
  videos: StudioVideo[];
  scripts: StudioScript[];
  agents: AgentState[];
  settings: StudioSettings;
  voice: { text: string; wpm: number; samples: number };
  system: SystemLoad;
  youtube: YouTubeStatus;
  categories: Record<string, string>;
  claude: boolean;
  deepFilter: boolean;
  root: string;
}

export interface LogLine {
  id: number;
  video_id: number | null;
  script_id: number | null;
  agent: string;
  level: "info" | "decision" | "warn" | "error";
  message: string;
  time: number;
}

interface Store {
  state: StudioState | null;
  system: SystemLoad | null;
  /** Bumped on every change, so log lists know when to read again. */
  tick: number;
  error: string | null;
}

export const useStudio = create<Store>(() => ({ state: null, system: null, tick: 0, error: null }));

export const call = <T = unknown>(method: string, ...args: unknown[]): Promise<T> => window.api.studioCall(method, ...args);

/** Run an action and show its failure in the panel instead of losing it. */
/** What a thumbnail was drawn from, so it can be changed in the thumbnail editor. */
export interface ThumbDesign {
  text?: string;
  accent?: string;
  textAt?: string;
  colour?: string;
  zoom?: { x: number; y: number; scale: number } | null;
  arrow?: unknown;
  ring?: unknown;
  faceAt?: string;
  frameFile: string;
  faceFile?: string | null;
  originalFace?: string | null;
  assetFile?: string | null;
  originalAsset?: string | null;
  plain?: boolean;
  extras?: { texts: { text: string; x: number; y: number; size: number; colour?: string }[]; images: { path: string; x: number; y: number; w: number }[] };
}

export async function act(method: string, ...args: unknown[]) {
  try {
    useStudio.setState({ error: null });
    return await call(method, ...args);
  } catch (err) {
    useStudio.setState({ error: (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") });
    return undefined;
  }
}

export async function refresh() {
  const state = await call<StudioState>("state");
  useStudio.setState((s) => ({ state, tick: s.tick + 1 }));
}

export function startStudio() {
  void refresh();
  const offChange = window.api.onStudioChanged(() => void refresh());
  const offSystem = window.api.onStudioSystem((system) => useStudio.setState({ system }));
  return () => {
    offChange();
    offSystem();
  };
}

export const clock = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(s % 60).padStart(2, "0")}`;
};

export const AGENT_NAMES: Record<string, string> = { director: "Direção", research: "Pesquisa", script: "Roteiro", ingest: "Ingestão", cut: "Corte", audio: "Áudio", edit: "Edição", metadata: "Metadados", thumbnail: "Thumbnail", assemble: "Montagem", review: "Correções", shorts: "Shorts", publish: "Publicação" };

/**
 * What an AI client can do to the project, exposed over MCP by electron/mcp.cjs. Tools call the
 * same store actions as the interface, so edits show up live and go through undo history.
 * Parameters are in seconds and use the model's field names; the store works in microseconds.
 */
import { oneUndoStep, useEditor, whenAllTracksReady, whenTracksReady } from "./store";
import { useUi, afterEdit, withLinked } from "./ui";
import { describeProgress, runAiTask, useAiJob } from "./ai";
import { clipTasks, processSound } from "./clipActions";
import { EXPORT_FORMATS, exportFormat, type ExportFormatId, type ExportQuality } from "./exportFormats";
import { addAudio } from "./components/SoundsTab";
import { addNarration, narratedHook } from "./narration";
import { audioPlan, creditsText, exportProject, renderFrameAt } from "./engine/exporter";
import { DEFAULT_TRANSITION_SHAPE, EFFECT_INFO, FILTER_INFO, TRANSITION_INFO } from "./engine/catalog";
import { MediaPool } from "./engine/mediaPool";
import { GOOGLE_FONTS, SYSTEM_FONTS, ensureProjectFonts } from "./fonts";
import { splitCaptions } from "./model/captions";
import { DEFAULT_TEXT, DEFAULT_TRANSFORM, createMask, findSegment, maxDuration, maxTransitionDuration, nextAdjacent, projectDuration, segmentEnd, uid } from "./model/project";
import { SECOND } from "./model/time";
import { ANIMATABLE, BLEND_MODES, EFFECTS, FILTERS, MASK_TYPES, MAX_VOLUME, SHAPE_KINDS, TRANSITIONS, TRANSITION_SHAPES } from "./model/types";
import { clearDucking, detectScenes, duckUnderVoice, findHighlights, punchZoom, removeSilences, verticalGamingLayout } from "./gaming";
import type { ChannelId, Easing, EffectType, Keyframe, Segment, Track, TransitionType } from "./model/types";
import { TEMPLATES, applyTemplate } from "./templates";
import type { AgentContent, AgentToolInfo, CaptionSegment, LibraryItem } from "./api";

/** The subset of JSON Schema these tools use; `check` enforces it so the AI gets a precise error. */
interface Schema {
  type?: string | string[];
  description?: string;
  enum?: readonly unknown[];
  minimum?: number;
  maximum?: number;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  minItems?: number;
  maxItems?: number;
}

// Arguments are checked against the tool's schema before `run` sees them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = Record<string, any>;

interface JobControl {
  /** Text for get_job while the work runs. */
  progress(read: () => string | null): void;
  onCancel(cancel: () => void): void;
}

interface Tool {
  name: string;
  /** Shown to the user in the activity list. */
  label: string;
  description: string;
  input: Record<string, Schema>;
  required?: string[];
  /**
   * edit: synchronous change, one undo step, rolled back if it throws.
   * job: long work that may outlive the call (see `get_job`). direct: just runs.
   */
  kind: "direct" | "edit" | "job";
  /** Only looks at the project, so the status bar stays out of it. */
  quiet?: boolean;
  run(args: Args, job: JobControl): unknown;
}

/** Tool output that carries images besides JSON. */
class Images {
  constructor(
    readonly images: { data: string; mimeType: string }[],
    readonly info: unknown,
  ) {}
}

const ed = () => useEditor.getState();
const us = (seconds: number) => Math.round(seconds * SECOND);
const sec = (micros: number) => Math.round(micros / 1000) / 1000;

// --- Schemas -------------------------------------------------------------------------------

const num = (description: string, limits: Pick<Schema, "minimum" | "maximum"> = {}): Schema => ({ type: "number", description, ...limits });
const str = (description: string): Schema => ({ type: "string", description });
const bool = (description: string): Schema => ({ type: "boolean", description });
const oneOf = (values: readonly unknown[], description: string): Schema => ({ type: "string", enum: values, description });
const list = (items: Schema, description: string): Schema => ({ type: "array", items, minItems: 1, description });
const object = (properties: Record<string, Schema>, description: string, nullable = false): Schema => ({ type: nullable ? ["object", "null"] : "object", properties, description });
const seconds = (description: string): Schema => num(description, { minimum: 0 });

const TRANSFORM = object(
  {
    x: num("Horizontal offset from the center; -1 and 1 reach the edges."),
    y: num("Vertical offset from the center; -1 is the top edge, 1 the bottom."),
    scale: num("1 fits the canvas.", { minimum: 0 }),
    rotation: num("Degrees."),
    opacity: num("0 to 1.", { minimum: 0, maximum: 1 }),
  },
  "Position and look. Setting an animated property replaces its keyframes with this value.",
);
const ADJUST = object(
  {
    brightness: num("1 is neutral.", { minimum: 0, maximum: 3 }),
    contrast: num("1 is neutral.", { minimum: 0, maximum: 3 }),
    saturation: num("1 is neutral, 0 is gray.", { minimum: 0, maximum: 3 }),
    blur: num("Pixels at 1080p.", { minimum: 0 }),
    temperature: num("-1 cool to 1 warm.", { minimum: -1, maximum: 1 }),
    tint: num("-1 green to 1 magenta.", { minimum: -1, maximum: 1 }),
    sharpen: num("0 to 1.", { minimum: 0, maximum: 1 }),
  },
  "Color adjustments.",
);
const CROP = object(
  { left: num("Fraction.", { minimum: 0, maximum: 1 }), top: num("Fraction.", { minimum: 0, maximum: 1 }), right: num("Fraction.", { minimum: 0, maximum: 1 }), bottom: num("Fraction.", { minimum: 0, maximum: 1 }) },
  "Fractions of the source frame cut from each side.",
);
const TEXT_STYLE = object(
  {
    content: str("The text; \\n breaks lines."),
    fontFamily: str("Font family; see list_catalog."),
    fontSource: oneOf(["installed", "custom", "google"], 'Where the font comes from. Use "google" for any Google Fonts family (it is downloaded); omit for the Windows fonts in list_catalog.'),
    fontSize: num("Pixels at 1080p.", { minimum: 1 }),
    color: str("CSS color, e.g. #ffffff."),
    bold: bool("Bold."),
    italic: bool("Italic."),
    align: oneOf(["left", "center", "right"], "Alignment."),
    strokeColor: str("Outline color."),
    strokeWidth: num("Outline width in pixels; 0 for none.", { minimum: 0 }),
    background: { type: ["string", "null"], description: "Color of a box behind the text, or null." },
  },
  "Text style.",
);
const FILTER = object(
  { type: oneOf(FILTERS, "Filter id."), intensity: num("0 to 1; default 1.", { minimum: 0, maximum: 1 }) },
  "Color filter, or null to remove it. One per clip.",
  true,
);
const MASK = object(
  {
    type: oneOf(MASK_TYPES, "Mask shape."),
    x: num("Center offset in half-clip units."),
    y: num("Center offset in half-clip units."),
    width: num("Fraction of the clip."),
    height: num("Fraction of the clip."),
    rotation: num("Degrees."),
    feather: num("Edge softness, 0 to 0.5.", { minimum: 0, maximum: 0.5 }),
    roundness: num("Corner rounding for rectangles, 0 to 1.", { minimum: 0, maximum: 1 }),
    invert: bool("Show the outside instead."),
    text: str('Text of a "text" mask.'),
  },
  "Mask, or null to remove it.",
  true,
);
const SHAPE = object(
  {
    kind: oneOf(SHAPE_KINDS, "Shape."),
    width: num("Pixels at 1080p.", { minimum: 1 }),
    height: num("Pixels at 1080p.", { minimum: 1 }),
    fill: { type: ["string", "null"], description: "Fill color, or null." },
    stroke: str("Outline color."),
    strokeWidth: num("Outline width.", { minimum: 0 }),
    roundness: num("Corner rounding for rectangles, 0 to 1.", { minimum: 0, maximum: 1 }),
    sides: num("Polygon sides or star points.", { minimum: 3 }),
  },
  "Vector shape.",
);
const STICKER = object({ emoji: str("One emoji."), size: num("Pixels at 1080p.", { minimum: 1 }) }, "Emoji sticker.");
const CLIP_IDS = list({ type: "string" }, "Clip ids.");
const TEXT_LINE = object({ start: seconds("Start."), end: seconds("End."), text: str("Text.") }, "One caption.");
TEXT_LINE.required = ["start", "end", "text"];

function check(value: unknown, schema: Schema, path: string) {
  const fail = (problem: string): never => {
    throw new Error(`${path}: ${problem}`);
  };
  if (schema.type) {
    const types = [schema.type].flat();
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (!types.includes(actual)) fail(`esperado ${types.join(" ou ")}, recebido ${actual}`);
    if (actual === "number" && !Number.isFinite(value)) fail("número inválido");
  }
  if (schema.enum && !schema.enum.includes(value)) fail(`use um destes valores: ${schema.enum.join(", ")}`);
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) fail(`mínimo ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(`máximo ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(`precisa de pelo menos ${schema.minItems} item(ns)`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(`no máximo ${schema.maxItems} itens`);
    if (schema.items) value.forEach((item, i) => check(item, schema.items!, `${path}[${i}]`));
  } else if (value && typeof value === "object" && schema.properties) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (obj[key] === undefined) fail(`falta "${key}"`);
    for (const [key, v] of Object.entries(obj)) {
      const inner = schema.properties[key];
      if (!inner) fail(`campo desconhecido "${key}"; válidos: ${Object.keys(schema.properties).join(", ")}`);
      else check(v, inner, `${path}.${key}`);
    }
  }
}

// --- Helpers -------------------------------------------------------------------------------

function clip(id: string) {
  const found = findSegment(ed().project, id);
  if (!found) throw new Error(`Clipe não encontrado: ${id}. Use get_project para ver os ids atuais.`);
  return found;
}

/** Store actions skip locked tracks silently; the AI should hear about it. */
function editable(id: string) {
  const found = clip(id);
  if (found.track.locked) throw new Error(`A faixa "${found.track.name}" está bloqueada.`);
  return found;
}

function clipType(s: Segment, track: Track) {
  if (s.adjustLayer) return "adjustment";
  if (s.text) return track.role === "captions" ? "caption" : "text";
  if (s.shape) return "shape";
  if (s.sticker) return "sticker";
  return (s.materialId && ed().project.materials[s.materialId]?.kind) || "unknown";
}

/** Compact view for listings: defaults are left out to keep long timelines readable. */
function describe(s: Segment, track: Track) {
  const material = s.materialId ? ed().project.materials[s.materialId] : undefined;
  const animated = Object.keys(s.keyframes);
  return {
    id: s.id,
    type: clipType(s, track),
    ...(material ? { name: material.name, materialId: material.id } : {}),
    ...(s.text ? { text: s.text.content } : {}),
    start: sec(s.start),
    end: sec(segmentEnd(s)),
    ...(material && material.kind !== "image" ? { sourceStart: sec(s.sourceStart) } : {}),
    ...(s.speed !== 1 ? { speed: s.speed } : {}),
    ...(material?.hasAudio ? { volume: s.volume } : {}),
    ...(s.filter ? { filter: s.filter.type } : {}),
    ...(s.effects.length ? { effects: s.effects.map((e) => e.type) } : {}),
    ...(s.transition ? { transition: s.transition.type, transitionDuration: sec(s.transition.duration) } : {}),
    ...(s.linkId ? { linkId: s.linkId } : {}),
    ...(animated.length ? { animated } : {}),
  };
}

const describeId = (id: string) => {
  const found = clip(id);
  return describe(found.segment, found.track);
};

const allClipIds = () => ed().project.tracks.flatMap((t) => t.segments.map((s) => s.id));

/** Text uses fonts that may need loading; the preview redraws once they arrive. */
function refreshFonts() {
  void ensureProjectFonts(ed().project).then(() => useEditor.setState((s) => ({ project: { ...s.project } })));
}

function patchClip(s: Segment, a: Args) {
  const material = s.materialId ? ed().project.materials[s.materialId] : undefined;
  for (const [prop, value] of Object.entries(a.transform ?? {})) {
    delete s.keyframes[prop as ChannelId];
    s.transform[prop as keyof Segment["transform"]] = value as number;
  }
  if (a.adjust) Object.assign(s.adjust, a.adjust);
  if (a.crop) Object.assign(s.crop, a.crop);
  if (a.filter !== undefined) s.filter = a.filter ? { intensity: 1, ...a.filter } : null;
  if (a.text) {
    if (!s.text) throw new Error(`O clipe ${s.id} não é um texto.`);
    Object.assign(s.text, a.text);
  }
  if (a.mask !== undefined) s.mask = a.mask ? { ...createMask(a.mask.type), ...a.mask } : null;
  if (a.shape) {
    if (!s.shape) throw new Error(`O clipe ${s.id} não é uma forma.`);
    Object.assign(s.shape, a.shape);
  }
  if (a.sticker) {
    if (!s.sticker) throw new Error(`O clipe ${s.id} não é um sticker.`);
    Object.assign(s.sticker, a.sticker);
  }
  if (a.fadeIn !== undefined) s.fadeIn = us(a.fadeIn);
  if (a.fadeOut !== undefined) s.fadeOut = us(a.fadeOut);
  if (a.volume !== undefined) s.volume = a.volume;
  if (a.blend !== undefined) s.blend = a.blend;
  if (a.flipX !== undefined) s.flipX = a.flipX;
  if (a.flipY !== undefined) s.flipY = a.flipY;
  if (a.keepPitch !== undefined) s.keepPitch = a.keepPitch;
  if (a.speed !== undefined) {
    // Same source range; the timeline length follows the speed, as in the inspector.
    const source = s.duration * s.speed;
    s.speed = a.speed;
    s.duration = Math.max(SECOND / 10, Math.min(Math.round(source / a.speed), maxDuration(s, material)));
  }
}

function absolute(path: string, extension: RegExp, label: string) {
  if (!/^([a-zA-Z]:[\\/]|\\\\)/.test(path)) throw new Error(`Informe o caminho completo do arquivo: ${path}`);
  if (!extension.test(path)) throw new Error(`O arquivo precisa terminar em ${label}: ${path}`);
  return path;
}

async function refuseOverwrite(path: string, overwrite: unknown) {
  if (!overwrite && (await window.api.fileExists(path))) throw new Error(`O arquivo já existe: ${path}. Pergunte ao usuário e passe overwrite: true para substituir.`);
}

function refuseDiscard(discard: unknown) {
  if (ed().dirty && !discard) throw new Error("O projeto atual tem alterações não salvas. Salve, ou pergunte ao usuário e passe discardChanges: true.");
}

const aiProgress = () => {
  const job = useAiJob.getState().job;
  return job ? describeProgress(job.progress).text : null;
};

/** Hooks up get_job and cancel_job for work done by the AI worker process. */
function aiJob(job: JobControl) {
  job.progress(aiProgress);
  job.onCancel(() => void window.api.aiCancel());
}

function transcribe(a: Args) {
  const { project, setPlaying } = ed();
  const audio = audioPlan(project);
  if (!audio.length) throw new Error("A timeline não tem nenhum clipe com áudio.");
  setPlaying(false);
  return runAiTask("Transcrição", "transcribe", { audio, duration: projectDuration(project), language: a.language ?? null, quality: a.quality ?? "accurate" });
}

const TRANSCRIBE_INPUT: Record<string, Schema> = {
  language: str('Spoken language code, such as "pt", "en" or "es". Omit to detect it.'),
  quality: oneOf(["fast", "accurate", "max"], "Model: fast (~140 MB), accurate (~500 MB, default) or max (~1 GB). Downloaded on first use."),
};

async function renderFrames(times: number[], maxWidth: number) {
  const { project } = ed();
  await ensureProjectFonts(project);
  const full = document.createElement("canvas");
  full.width = project.width;
  full.height = project.height;
  const ctx = full.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas 2D indisponível");
  const scale = Math.min(1, maxWidth / project.width);
  const small = document.createElement("canvas");
  small.width = Math.round(project.width * scale);
  small.height = Math.round(project.height * scale);
  const smallCtx = small.getContext("2d")!;
  const pool = new MediaPool(true);
  try {
    const images: { data: string; mimeType: string }[] = [];
    for (const t of times) {
      await renderFrameAt(ctx, project, t, pool);
      smallCtx.drawImage(full, 0, 0, small.width, small.height);
      images.push({ data: small.toDataURL("image/jpeg", 0.85).split(",")[1], mimeType: "image/jpeg" });
    }
    return images;
  } finally {
    pool.destroy();
  }
}

/** Sounds from the last searches, by id, so add_sound needs only the id. */
const sounds = new Map<string, { path?: string; item?: LibraryItem }>();

// --- Tools ---------------------------------------------------------------------------------

const TOOLS: Tool[] = [
  {
    name: "get_project",
    quiet: true,
    label: "Leu o projeto",
    description: "The whole project: settings, imported media, tracks with their clips, markers, playhead and selection. Tracks are listed top to bottom; the last video track is the main one.",
    input: {},
    kind: "direct",
    run() {
      const { project: p, projectPath, dirty, playhead, selectedId, past, future } = ed();
      const { magnet } = useUi.getState();
      return {
        name: p.name,
        path: projectPath,
        unsavedChanges: dirty,
        width: p.width,
        height: p.height,
        fps: p.fps,
        duration: sec(projectDuration(p)),
        playhead: sec(playhead),
        selectedClip: selectedId,
        background: p.backgroundMode === "blur" ? "blur" : p.background,
        magnet,
        canUndo: past.length > 0,
        canRedo: future.length > 0,
        materials: Object.values(p.materials).map((m) => ({
          id: m.id,
          name: m.name,
          kind: m.kind,
          path: m.path,
          duration: sec(m.duration),
          ...(m.width ? { width: m.width, height: m.height } : {}),
          hasAudio: m.hasAudio,
        })),
        tracks: p.tracks.map((t) => ({
          id: t.id,
          kind: t.kind,
          name: t.name,
          ...(t.role ? { role: t.role } : {}),
          ...(t.muted ? { muted: true } : {}),
          ...(t.hidden ? { hidden: true } : {}),
          ...(t.locked ? { locked: true } : {}),
          clips: t.segments.map((s) => describe(s, t)),
        })),
        markers: p.markers.map((m) => ({ id: m.id, time: sec(m.time), label: m.label, ...(m.note ? { note: m.note } : {}) })),
      };
    },
  },
  {
    name: "get_clip",
    quiet: true,
    label: "Leu um clipe",
    description: "Every property of one clip, with times in seconds.",
    input: { clipId: str("Clip id.") },
    required: ["clipId"],
    kind: "direct",
    run(a) {
      const s = clip(a.clipId).segment;
      const keyframes = Object.fromEntries(Object.entries(s.keyframes).map(([k, frames]) => [k, (frames as Keyframe[]).map((f) => ({ ...f, time: sec(f.time) }))]));
      return {
        ...s,
        start: sec(s.start),
        duration: sec(s.duration),
        sourceStart: sec(s.sourceStart),
        fadeIn: sec(s.fadeIn),
        fadeOut: sec(s.fadeOut),
        transition: s.transition && { ...s.transition, duration: sec(s.transition.duration) },
        keyframes,
      };
    },
  },
  {
    name: "list_catalog",
    quiet: true,
    label: "Consultou o catálogo",
    description: "Valid ids, with Portuguese labels, for filters, effects, transitions, templates, blend modes, masks, shapes and fonts.",
    input: {},
    kind: "direct",
    run: () => ({
      filters: FILTERS.map((id) => ({ id, label: FILTER_INFO[id].label, group: FILTER_INFO[id].group })),
      effects: EFFECTS.map((id) => ({ id, label: EFFECT_INFO[id].label })),
      transitions: TRANSITIONS.map((id) => ({ id, label: TRANSITION_INFO[id].label })),
      transitionShapes: TRANSITION_SHAPES,
      templates: TEMPLATES.map((t) => ({ id: t.id, label: t.label, description: t.description })),
      blendModes: BLEND_MODES,
      maskTypes: MASK_TYPES,
      shapeKinds: SHAPE_KINDS,
      fonts: { windows: SYSTEM_FONTS, googleSuggestions: GOOGLE_FONTS },
    }),
  },
  {
    name: "get_frame",
    quiet: true,
    label: "Olhou um quadro",
    description: "Render timeline frames exactly as they will export, returned as images. Use it to check the result.",
    input: {
      times: { ...list(seconds("Time."), "Up to 8 times to render. Default: the playhead."), maxItems: 8 },
      maxWidth: num("Longest width of the images in pixels; default 1024.", { minimum: 64, maximum: 3840 }),
    },
    kind: "direct",
    async run(a) {
      const times: number[] = a.times ? a.times.map(us) : [ed().playhead];
      return new Images(await renderFrames(times, a.maxWidth ?? 1024), { times: times.map(sec) });
    },
  },
  {
    name: "import_media",
    label: "Importou mídia",
    description: "Add video, audio or image files to the project's media. This does not put them on the timeline; use add_clip for that. The first video sets the canvas size and frame rate.",
    input: { paths: list({ type: "string" }, "Absolute file paths.") },
    required: ["paths"],
    kind: "direct",
    async run(a) {
      const added = await ed().importFiles(a.paths);
      // The AI sees the finished project: extra recording tracks (OBS) included.
      await Promise.all(added.map((m) => whenTracksReady(m.id)));
      const imported = new Set(added.map((m) => m.path));
      return {
        materials: added.map((m) => ({ id: m.id, name: m.name, kind: m.kind, duration: sec(m.duration), width: m.width, height: m.height, hasAudio: m.hasAudio })),
        failed: a.paths.filter((p: string) => !imported.has(p)),
      };
    },
  },
  {
    name: "remove_media",
    label: "Removeu mídia",
    description: "Remove imported media from the project, together with every clip that uses it. The file on disk is not touched.",
    input: { materialIds: list({ type: "string" }, "Media ids from get_project.") },
    required: ["materialIds"],
    kind: "edit",
    run(a) {
      for (const id of a.materialIds) if (!ed().project.materials[id]) throw new Error(`Mídia não encontrada: ${id}.`);
      const clips = ed().removeMaterials(a.materialIds);
      afterEdit();
      return { removed: a.materialIds, clipsRemoved: clips };
    },
  },
  {
    name: "add_clip",
    label: "Adicionou um clipe",
    description:
      "Put imported media on the timeline. Without start or trackId, video goes to the end of the main track and audio to the playhead. Use overlay: true for graphics that go over the video, such as transparent WebM renders from HyperFrames.",
    input: {
      materialId: str("Id from get_project or import_media."),
      start: seconds("Timeline position."),
      trackId: str("Track to use."),
      sourceStart: seconds("Where in the media to start."),
      duration: num("Timeline length; default: up to the end of the media.", { minimum: 0.01 }),
      overlay: bool("Video or image on a track above the main one (default start: the playhead), so transparent areas show the video below."),
    },
    required: ["materialId"],
    kind: "edit",
    run(a) {
      const id = ed().addMaterialToTimeline(a.materialId, {
        overlay: Boolean(a.overlay),
        trackId: a.trackId,
        start: a.start === undefined ? undefined : us(a.start),
        sourceStart: a.sourceStart === undefined ? undefined : us(a.sourceStart),
        duration: a.duration === undefined ? undefined : us(a.duration),
      });
      if (!id) throw new Error(`Mídia não encontrada: ${a.materialId}.`);
      return describeId(id);
    },
  },
  {
    name: "add_text",
    label: "Adicionou um texto",
    description: "Add a text clip on an overlay track.",
    input: { content: str("The text."), start: seconds("Default: the playhead."), duration: num("Default 3.", { minimum: 0.01 }), style: TEXT_STYLE, transform: TRANSFORM },
    required: ["content"],
    kind: "edit",
    run(a) {
      const [id] = ed().insertOverlays([
        {
          start: a.start === undefined ? ed().playhead : us(a.start),
          duration: us(a.duration ?? 3),
          text: { ...DEFAULT_TEXT, ...a.style, content: a.content },
          transform: { ...DEFAULT_TRANSFORM, ...a.transform },
        },
      ]);
      refreshFonts();
      return describeId(id);
    },
  },
  {
    name: "add_overlay",
    label: "Adicionou uma camada",
    description: "Add a shape, an emoji sticker, or an adjustment layer (its adjust and filter apply to everything below it while active).",
    input: {
      type: oneOf(["shape", "sticker", "adjustment"], "What to add."),
      start: seconds("Default: the playhead."),
      duration: num("Default 3.", { minimum: 0.01 }),
      shape: SHAPE,
      sticker: STICKER,
      adjust: ADJUST,
      filter: FILTER,
      transform: TRANSFORM,
    },
    required: ["type"],
    kind: "edit",
    run(a) {
      const content: Partial<Segment> = { transform: { ...DEFAULT_TRANSFORM, ...a.transform } };
      if (a.type === "shape") content.shape = { kind: "rectangle", width: 400, height: 400, fill: "#22c3b5", stroke: "#ffffff", strokeWidth: 0, roundness: 0, sides: 5, ...a.shape };
      if (a.type === "sticker") content.sticker = { emoji: "⭐", size: 300, ...a.sticker };
      if (a.type === "adjustment") content.adjustLayer = true;
      const [id] = ed().insertOverlays([{ ...content, start: a.start === undefined ? ed().playhead : us(a.start), duration: us(a.duration ?? 3) }]);
      if (a.adjust || a.filter) ed().updateSegment(id, (s) => patchClip(s, { adjust: a.adjust, filter: a.filter }));
      return describeId(id);
    },
  },
  {
    name: "add_captions",
    label: "Adicionou legendas",
    description: 'Put caption lines on a "Legendas" track. Overlapping lines are skipped.',
    input: {
      lines: list(TEXT_LINE, "Captions, in timeline seconds."),
      replace: bool("Replace existing caption tracks. Default false."),
      style: TEXT_STYLE,
      y: num("Vertical position; default 0.72 (near the bottom)."),
    },
    required: ["lines"],
    kind: "edit",
    run(a) {
      const added = ed().addCaptions(a.lines as CaptionSegment[], Boolean(a.replace));
      if (added && (a.style || a.y !== undefined)) {
        ed().mutate((p) => {
          // New caption tracks are added on top.
          for (const s of p.tracks.find((t) => t.role === "captions")!.segments) {
            if (s.text) Object.assign(s.text, a.style, { content: s.text.content });
            if (a.y !== undefined) s.transform.y = a.y;
          }
        });
        refreshFonts();
      }
      return { added, skipped: a.lines.length - added };
    },
  },
  {
    name: "apply_template",
    label: "Aplicou um modelo",
    description: "Insert a ready-made animated template. Change its texts with update_clip afterwards.",
    input: { templateId: oneOf(TEMPLATES.map((t) => t.id), "Template id."), start: seconds("Default: the playhead.") },
    required: ["templateId"],
    kind: "edit",
    run(a) {
      const { playhead, setPlayhead } = ed();
      const before = new Set(allClipIds());
      if (a.start !== undefined) useEditor.setState({ playhead: us(a.start) });
      try {
        applyTemplate(TEMPLATES.find((t) => t.id === a.templateId)!);
      } finally {
        setPlayhead(playhead);
      }
      return { added: allClipIds().filter((id) => !before.has(id)).map(describeId) };
    },
  },
  {
    name: "update_clip",
    label: "Alterou um clipe",
    description: "Change properties of one or more clips; only the fields you pass change. Works for video, images, audio, text, shapes and stickers.",
    input: {
      clipIds: CLIP_IDS,
      transform: TRANSFORM,
      adjust: ADJUST,
      crop: CROP,
      filter: FILTER,
      text: TEXT_STYLE,
      mask: MASK,
      shape: SHAPE,
      sticker: STICKER,
      speed: num("Playback speed; the clip's length follows it.", { minimum: 0.1, maximum: 8 }),
      keepPitch: bool("Keep the voice's pitch when the speed changes."),
      volume: num(`0 to ${MAX_VOLUME} (1 is the original level). Ignored while the clip has a volume curve; see set_keyframes.`, { minimum: 0, maximum: MAX_VOLUME }),
      fadeIn: seconds("Fade-in length."),
      fadeOut: seconds("Fade-out length."),
      blend: oneOf(BLEND_MODES, "Blend mode."),
      flipX: bool("Mirror horizontally."),
      flipY: bool("Mirror vertically."),
    },
    required: ["clipIds"],
    kind: "edit",
    run({ clipIds, ...patch }) {
      for (const id of clipIds) editable(id);
      const { speed, ...rest } = patch;
      for (const id of clipIds) ed().updateSegment(id, (s) => patchClip(s, rest));
      // Speed goes through the store, so the clips after it close up (or make room) like in the inspector.
      if (speed !== undefined) for (const id of clipIds) ed().setSpeed(id, speed, { magnet: useUi.getState().magnet, link: useUi.getState().link });
      if (patch.text) refreshFonts();
      return { updated: clipIds.map(describeId) };
    },
  },
  {
    name: "set_keyframes",
    label: "Animou um clipe",
    description: "Replace the animation of one property of a clip. Keyframe times are seconds from the clip's start. An empty list removes the animation.",
    input: {
      clipId: str("Clip id."),
      property: oneOf([...ANIMATABLE, "volume", ...EFFECTS], `A transform property, "volume" (0 to ${MAX_VOLUME}), or the id of an effect on the clip to animate its intensity.`),
      keyframes: {
        type: "array",
        description: "Keyframes.",
        items: {
          type: "object",
          required: ["time", "value"],
          properties: {
            time: seconds("Seconds from the clip's start."),
            value: num("Value."),
            easing: { description: 'Curve to the next keyframe: "linear", "easeIn", "easeOut", "easeInOut", "hold", or a cubic-bezier as [x1, y1, x2, y2].' },
          },
        },
      },
    },
    required: ["clipId", "property", "keyframes"],
    kind: "edit",
    run(a) {
      const { segment } = editable(a.clipId);
      let channel = a.property as ChannelId;
      if ((EFFECTS as readonly string[]).includes(a.property)) {
        const effect = segment.effects.find((e) => e.type === a.property);
        if (!effect) throw new Error(`O clipe não tem o efeito ${a.property}. Use add_effect antes.`);
        channel = `fx:${effect.id}`;
      }
      const frames: Keyframe[] = a.keyframes
        .map((k: { time: number; value: number; easing?: Easing }) => {
          const named = typeof k.easing === "string" && ["linear", "easeIn", "easeOut", "easeInOut", "hold"].includes(k.easing);
          const bezier = Array.isArray(k.easing) && k.easing.length === 4 && k.easing.every(Number.isFinite);
          if (k.easing !== undefined && !named && !bezier) throw new Error(`Curva inválida: ${JSON.stringify(k.easing)}.`);
          if (us(k.time) > segment.duration) throw new Error(`O keyframe em ${k.time} s passa do fim do clipe (${sec(segment.duration)} s).`);
          return { time: us(k.time), value: k.value, ...(k.easing !== undefined ? { easing: k.easing } : {}) };
        })
        .sort((x: Keyframe, y: Keyframe) => x.time - y.time);
      ed().updateSegment(a.clipId, (s) => {
        if (frames.length) s.keyframes[channel] = frames;
        else delete s.keyframes[channel];
      });
      return describeId(a.clipId);
    },
  },
  {
    name: "split_clip",
    label: "Dividiu um clipe",
    description: "Cut at a time: one clip, or every clip under that time when clipId is omitted. Linked clips are cut together.",
    input: { time: seconds("Timeline time."), clipId: str("Clip to cut.") },
    required: ["time"],
    kind: "edit",
    run(a) {
      if (a.clipId) editable(a.clipId);
      const { selectedId } = ed();
      const before = new Set(allClipIds());
      ed().select(a.clipId ?? null);
      ed().splitAt(us(a.time), a.clipId);
      if (!a.clipId) ed().select(selectedId);
      const created = allClipIds().filter((id) => !before.has(id));
      if (!created.length) throw new Error(`Nada para dividir em ${a.time} s.`);
      return { created: created.map(describeId) };
    },
  },
  {
    name: "trim_clip",
    label: "Aparou um clipe",
    description: "Move a clip's edges, given as timeline times. Limited by the neighbours and the media's length, so check the returned clip.",
    input: { clipId: str("Clip id."), start: seconds("New start."), end: seconds("New end."), ripple: bool("When moving the end, later clips on the track move along.") },
    required: ["clipId"],
    kind: "edit",
    run(a) {
      editable(a.clipId);
      if (a.start === undefined && a.end === undefined) throw new Error("Informe start ou end.");
      if (a.start !== undefined) ed().trimSegment(a.clipId, "start", us(a.start));
      if (a.end !== undefined) ed().trimSegment(a.clipId, "end", us(a.end), Boolean(a.ripple));
      afterEdit();
      return describeId(a.clipId);
    },
  },
  {
    name: "move_clip",
    label: "Moveu um clipe",
    description: "Move a clip, and the clips linked to it, to a free position. To change the order on a track, use reorder_clips.",
    input: { clipId: str("Clip id."), start: seconds("New timeline position."), trackId: str("Track of the same kind to move to.") },
    required: ["clipId", "start"],
    kind: "edit",
    run(a) {
      const { segment, track } = editable(a.clipId);
      const target = us(a.start);
      if (a.trackId && a.trackId !== track.id) ed().moveSegment(a.clipId, target, a.trackId);
      else ed().moveSegments(withLinked([a.clipId]), target - segment.start);
      const moved = clip(a.clipId);
      const frame = SECOND / ed().project.fps;
      if (Math.abs(moved.segment.start - target) > frame || (a.trackId && moved.track.id !== a.trackId)) throw new Error("Essa posição está ocupada, ou a faixa é de outro tipo.");
      afterEdit();
      return describeId(a.clipId);
    },
  },
  {
    name: "reorder_clips",
    label: "Reordenou clipes",
    description: "Set the order of all clips on a track; they end up back to back. Linked audio follows. Use it to rearrange scenes on the main track.",
    input: { trackId: str("Track id."), clipIds: list({ type: "string" }, "All the track's clip ids, in the new order.") },
    required: ["trackId", "clipIds"],
    kind: "edit",
    run(a) {
      const track = ed().project.tracks.find((t) => t.id === a.trackId);
      if (!track) throw new Error(`Faixa não encontrada: ${a.trackId}.`);
      if (track.locked) throw new Error(`A faixa "${track.name}" está bloqueada.`);
      const ids = new Set<string>(a.clipIds);
      if (ids.size !== track.segments.length || a.clipIds.length !== ids.size || track.segments.some((s) => !ids.has(s.id))) throw new Error("Liste todos os clipes da faixa, cada um uma vez.");
      ed().reorderClips(a.trackId, a.clipIds);
      return { clips: a.clipIds.map(describeId) };
    },
  },
  {
    name: "delete_clips",
    label: "Excluiu clipes",
    description: "Delete clips and the clips linked to them.",
    input: { clipIds: CLIP_IDS, ripple: bool("Later clips on the same track move back to close the gap.") },
    required: ["clipIds"],
    kind: "edit",
    run(a) {
      for (const id of a.clipIds) editable(id);
      const ids = withLinked(a.clipIds);
      ed().deleteSegments(ids, a.ripple ?? useUi.getState().ripple, useUi.getState().magnet);
      afterEdit();
      return { deleted: ids, duration: sec(projectDuration(ed().project)) };
    },
  },
  {
    name: "remove_ranges",
    label: "Cortou trechos",
    description:
      "Cut stretches of time out of the timeline: clips are split at the edges, the inside goes away and everything after moves back, keeping video, audio and captions in sync. Give all ranges in one call, in the timeline's current times. Ideal for silences, mistakes and filler words.",
    input: {
      ranges: list(
        { type: "object", required: ["start", "end"], properties: { start: seconds("Start."), end: seconds("End.") } },
        "Stretches to remove.",
      ),
      trackIds: list({ type: "string" }, "Limit the cut to these tracks. Default: every unlocked track, plus markers."),
    },
    required: ["ranges"],
    kind: "edit",
    run(a) {
      const sorted = [...a.ranges].sort((x, y) => x.start - y.start);
      const merged: { start: number; end: number }[] = [];
      for (const r of sorted) {
        if (r.end <= r.start) throw new Error(`Trecho inválido: ${r.start} a ${r.end}.`);
        const last = merged[merged.length - 1];
        if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
        else merged.push({ ...r });
      }
      const before = projectDuration(ed().project);
      // Last to first, so each cut leaves the earlier times valid.
      for (const r of merged.reverse()) ed().removeRange(us(r.start), us(r.end), a.trackIds);
      afterEdit();
      const after = projectDuration(ed().project);
      return { removedSeconds: sec(before - after), duration: sec(after) };
    },
  },
  {
    name: "set_transition",
    label: "Definiu uma transição",
    description: "Set the transition from a video clip into the one right after it, or pass type null to remove it. The next clip must touch this one.",
    input: {
      clipId: str("The clip before the cut."),
      type: { type: ["string", "null"], enum: [...TRANSITIONS, null], description: "Transition id, or null." },
      duration: num("Default 0.5; limited by the clips' length.", { minimum: 0.03 }),
      shape: object(
        { kind: oneOf(TRANSITION_SHAPES, "Shape."), text: str('Text for kind "text".'), direction: oneOf(["grow", "shrink"], "Direction."), softness: num("0 to 0.3.", { minimum: 0, maximum: 0.3 }), rotate: bool("Quarter turn.") },
        'Settings for type "shape".',
      ),
    },
    required: ["clipId", "type"],
    kind: "edit",
    run(a) {
      const { track, segment, index } = editable(a.clipId);
      if (a.type === null) {
        ed().setTransition(a.clipId, null);
        return describeId(a.clipId);
      }
      const next = track.kind === "video" ? nextAdjacent(track, index) : null;
      if (!next) throw new Error("A transição fica no corte entre dois clipes de vídeo encostados, e este clipe não tem outro logo depois.");
      const duration = Math.min(us(a.duration ?? 0.5), maxTransitionDuration(segment, next));
      ed().setTransition(a.clipId, { type: a.type as TransitionType, duration, ...(a.type === "shape" ? { shape: { ...DEFAULT_TRANSITION_SHAPE, ...a.shape } } : {}) });
      return describeId(a.clipId);
    },
  },
  {
    name: "add_effect",
    label: "Aplicou um efeito",
    description: "Add an effect to clips. There is one of each type per clip.",
    input: { clipIds: CLIP_IDS, type: oneOf(EFFECTS, "Effect id."), intensity: num("0 to 1; default 1.", { minimum: 0, maximum: 1 }) },
    required: ["clipIds", "type"],
    kind: "edit",
    run(a) {
      for (const id of a.clipIds) editable(id);
      for (const id of a.clipIds) {
        ed().addEffect(id, a.type as EffectType);
        const effect = clip(id).segment.effects.find((e) => e.type === a.type)!;
        if (a.intensity !== undefined) ed().updateEffect(id, effect.id, a.intensity);
      }
      return { updated: a.clipIds.map(describeId) };
    },
  },
  {
    name: "remove_effect",
    label: "Removeu um efeito",
    description: "Remove one effect from clips, or all of them when type is omitted.",
    input: { clipIds: CLIP_IDS, type: oneOf(EFFECTS, "Effect id.") },
    required: ["clipIds"],
    kind: "edit",
    run(a) {
      for (const id of a.clipIds) editable(id);
      for (const id of a.clipIds) for (const e of clip(id).segment.effects) if (!a.type || e.type === a.type) ed().removeEffect(id, e.id);
      return { updated: a.clipIds.map(describeId) };
    },
  },
  {
    name: "detach_audio",
    label: "Separou o áudio",
    description: "Move a video clip's sound to its own linked audio clip.",
    input: { clipId: str("Video clip id.") },
    required: ["clipId"],
    kind: "edit",
    run(a) {
      editable(a.clipId);
      const id = ed().detachAudio(a.clipId);
      if (!id) throw new Error("Este clipe não tem som para separar.");
      return describeId(id);
    },
  },
  {
    name: "add_marker",
    label: "Adicionou um marcador",
    description: "Add a timeline marker: a point the user wants to come back to. Put the reason in note.",
    input: { time: seconds("Timeline time."), label: str("Label."), note: str("Why this point is marked."), color: str("CSS color.") },
    required: ["time"],
    kind: "edit",
    run(a) {
      const id = ed().addMarker(us(a.time));
      if (a.label || a.color || a.note) ed().updateMarker(id, { ...(a.label ? { label: a.label } : {}), ...(a.color ? { color: a.color } : {}), ...(a.note ? { note: a.note } : {}) });
      return { id };
    },
  },
  {
    name: "remove_marker",
    label: "Removeu um marcador",
    description: "Remove a timeline marker.",
    input: { markerId: str("Marker id.") },
    required: ["markerId"],
    kind: "edit",
    run(a) {
      if (!ed().project.markers.some((m) => m.id === a.markerId)) throw new Error(`Marcador não encontrado: ${a.markerId}.`);
      ed().removeMarker(a.markerId);
      return { removed: a.markerId };
    },
  },
  {
    name: "update_project",
    label: "Alterou o projeto",
    description: "Change project settings. For vertical video use 1080 x 1920. The magnet makes the main track close its gaps.",
    input: {
      name: str("Project name."),
      width: num("Canvas width.", { minimum: 16, maximum: 7680 }),
      height: num("Canvas height.", { minimum: 16, maximum: 7680 }),
      fps: num("Frames per second.", { minimum: 1, maximum: 120 }),
      background: str("Background color."),
      backgroundMode: oneOf(["color", "blur"], "Solid color, or the bottom clip blurred."),
      backgroundBlur: num("Blur radius at 1080p.", { minimum: 0 }),
      magnet: bool("Main track magnet."),
    },
    kind: "edit",
    run({ magnet, ...patch }) {
      const even = (n: number) => 2 * Math.round(n / 2);
      if (Object.keys(patch).length) {
        ed().mutate((p) => {
          Object.assign(p, patch);
          // H.264 needs even dimensions.
          p.width = even(p.width);
          p.height = even(p.height);
        });
      }
      if (magnet !== undefined) useUi.setState({ magnet });
      const { name, width, height, fps } = ed().project;
      return { name, width, height, fps, magnet: useUi.getState().magnet };
    },
  },
  {
    name: "set_playhead",
    label: "Moveu o cursor",
    description: "Move the playhead, to show the user a moment.",
    input: { time: seconds("Timeline time.") },
    required: ["time"],
    kind: "direct",
    run(a) {
      ed().setPlaying(false);
      ed().setPlayhead(us(a.time));
      return { playhead: sec(ed().playhead) };
    },
  },
  {
    name: "undo",
    label: "Desfez",
    description: "Undo the last edit, yours or the user's. One edit tool or one batch is one step.",
    input: {},
    kind: "direct",
    run() {
      if (!ed().past.length) throw new Error("Não há nada para desfazer.");
      ed().undo();
      return { canUndo: ed().past.length > 0, canRedo: true };
    },
  },
  {
    name: "redo",
    label: "Refez",
    description: "Redo the last undone edit.",
    input: {},
    kind: "direct",
    run() {
      if (!ed().future.length) throw new Error("Não há nada para refazer.");
      ed().redo();
      return { canUndo: true, canRedo: ed().future.length > 0 };
    },
  },
  {
    name: "batch",
    label: "Fez várias edições",
    description: "Run several edit tools in order as a single undo step. If one fails, nothing is applied. Only tools that edit the timeline are allowed, not ones that import, process or export.",
    input: {
      operations: list(
        { type: "object", required: ["tool"], properties: { tool: str("Tool name."), args: { type: "object", description: "Its arguments." } } },
        "Operations.",
      ),
    },
    required: ["operations"],
    kind: "edit",
    run(a) {
      const results: unknown[] = [];
      a.operations.forEach((op: { tool: string; args?: Args }, i: number) => {
        const tool = TOOLS.find((t) => t.name === op.tool);
        try {
          if (!tool || tool.kind !== "edit" || tool.name === "batch") throw new Error(`"${op.tool}" não pode ser usada em batch.`);
          results.push(tool.run(validated(tool, op.args ?? {}), NO_JOB));
        } catch (err) {
          throw new Error(`Operação ${i + 1} (${op.tool}): ${(err as Error).message} Nada foi aplicado.`);
        }
      });
      return { results };
    },
  },
  {
    name: "get_transcript",
    label: "Transcrevendo o áudio",
    description: "Transcribe the timeline's audio with Whisper, running on this computer. Returns lines with timeline times and changes nothing, so it is the base for editing by speech.",
    input: TRANSCRIBE_INPUT,
    kind: "job",
    async run(a, job) {
      aiJob(job);
      const { segments } = await transcribe(a);
      return { lines: segments };
    },
  },
  {
    name: "auto_captions",
    label: "Gerando legendas",
    description: 'Transcribe the audio and create captions on a "Legendas" track.',
    input: { ...TRANSCRIBE_INPUT, maxWords: num("Words per caption; default 6.", { minimum: 1, maximum: 30 }), replace: bool("Replace existing caption tracks. Default true.") },
    kind: "job",
    async run(a, job) {
      aiJob(job);
      const { segments } = await transcribe(a);
      return { added: ed().addCaptions(splitCaptions(segments, a.maxWords ?? 6), a.replace ?? true) };
    },
  },
  {
    name: "process_clip",
    label: "Processando um clipe",
    description:
      "Run a processing tool on a clip. removeBackground keeps only the people. reverse plays it backwards (up to 3 minutes). enhance upscales and sharpens the picture. denoise cleans the sound; enhanceVoice polishes commentary (noise, EQ, de-esser, compressor, speech loudness). Both move a video's sound to a linked audio clip first. freezeFrame inserts a 3 s still at `time`, pushing the rest right.",
    input: {
      clipId: str("Clip id."),
      clipIds: list(str("Clip id."), "For denoise and enhanceVoice: several clips processed one after another (e.g. every commentary track), instead of clipId."),
      action: oneOf(["removeBackground", "reverse", "enhance", "denoise", "enhanceVoice", "freezeFrame"], "What to do."),
      time: seconds("For freezeFrame: the timeline time to freeze."),
    },
    required: ["action"],
    kind: "job",
    async run(a, job) {
      aiJob(job);
      if (a.clipIds) {
        if (a.action !== "denoise" && a.action !== "enhanceVoice") throw new Error("clipIds só vale para denoise e enhanceVoice.");
        for (const id of a.clipIds) editable(id);
        const r = await processSound(a.clipIds, a.action === "denoise" ? "denoise" : "voice");
        if (r.cancelled) throw new Error("Cancelado.");
        if (!r.done && r.errors.length) throw new Error(r.errors[0]);
        return { processed: r.done, errors: r.errors, selectedClip: ed().selectedId };
      }
      if (!a.clipId) throw new Error("Informe clipId ou clipIds.");
      editable(a.clipId);
      const action = (a.action === "enhanceVoice" ? "voice" : a.action) as keyof typeof clipTasks;
      if (action === "freezeFrame") {
        if (a.time === undefined) throw new Error("Informe time para congelar o quadro.");
        ed().setPlayhead(us(a.time));
      }
      await clipTasks[action](a.clipId);
      return { clip: allClipIds().includes(a.clipId) ? describeId(a.clipId) : null, selectedClip: ed().selectedId };
    },
  },
  {
    name: "remove_silences",
    label: "Cortando silêncios",
    description:
      "Cut the pauses out of a clip with speech or sound, measured from its audio (fast, no transcription). Everything after each cut moves back on every track, so video, audio and captions stay in sync. Use the commentary clip when the voice has its own track.",
    input: {
      clipId: str("Clip whose sound decides what is silence."),
      minSilence: num("Shortest pause to cut, in seconds; default 0.7.", { minimum: 0.2, maximum: 10 }),
      padding: num("Seconds of breath kept on each side of a cut; default 0.15.", { minimum: 0, maximum: 1 }),
    },
    required: ["clipId"],
    kind: "job",
    run: (a) => removeSilences(a.clipId, { minSilence: a.minSilence, padding: a.padding }),
  },
  {
    name: "duck_audio",
    label: "Abaixando o som sob a voz",
    description:
      "Ducking: while the voice clip speaks, every other sound (game, music, chat) dips to `level`, with an attack before and a release after each phrase. Writes volume curves on those clips, replacing earlier ones.",
    input: {
      voiceClipId: str("The commentary clip (often the second audio track of an OBS recording)."),
      level: num("Volume of the other sounds while speaking, 0 to 1; default 0.25.", { minimum: 0, maximum: 1 }),
      attack: num("Seconds the dip starts before speech; default 0.15.", { minimum: 0, maximum: 2 }),
      release: num("Seconds to come back after speech; default 0.5.", { minimum: 0, maximum: 3 }),
      targetClipIds: list({ type: "string" }, "Only duck these clips. Default: every other clip with sound."),
    },
    required: ["voiceClipId"],
    kind: "job",
    run: (a) => duckUnderVoice(a.voiceClipId, { level: a.level, attack: a.attack, release: a.release, targetIds: a.targetClipIds }),
  },
  {
    name: "clear_ducking",
    label: "Tirou o ducking",
    description: "Remove the volume curves of clips, back to their plain volume.",
    input: { clipIds: CLIP_IDS },
    required: ["clipIds"],
    kind: "edit",
    run(a) {
      for (const id of a.clipIds) editable(id);
      clearDucking(a.clipIds);
      return { cleared: a.clipIds.length };
    },
  },
  {
    name: "find_highlights",
    label: "Procurando os momentos altos",
    description:
      'Find the loudest moments of a clip (fights, explosions, shouting) and mark them with "Destaque" markers. Returns their times, a starting point for a best-moments cut. Default clip: the longest one with sound on the main track.',
    input: {
      clipId: str("Clip to analyze."),
      count: num("How many moments; default 6.", { minimum: 1, maximum: 30 }),
      window: num("Length of a moment in seconds; default 2.5.", { minimum: 0.5, maximum: 20 }),
    },
    kind: "job",
    run: (a) => findHighlights(a.clipId, { count: a.count, window: a.window }),
  },
  {
    name: "detect_scenes",
    label: "Detectando cenas",
    description: 'Find the shot changes of a video clip. Marks them with "Cena" markers, or splits the clip there with split: true. Takes a while on long videos.',
    input: {
      clipId: str("Video clip."),
      threshold: num("Sensitivity 0.1 (many cuts) to 0.8 (only hard cuts); default 0.3.", { minimum: 0.05, maximum: 0.95 }),
      split: bool("Split the clip at each change instead of marking."),
    },
    required: ["clipId"],
    kind: "job",
    run: (a) => detectScenes(a.clipId, { threshold: a.threshold, split: a.split }),
  },
  {
    name: "punch_zoom",
    label: "Zoom de impacto",
    description: "A quick punch-in zoom on a moment of a clip: zooms in fast, holds, eases back out.",
    input: {
      clipId: str("Clip id."),
      time: seconds("Timeline time of the moment."),
      amount: num("Zoom factor; default 1.3.", { minimum: 1.05, maximum: 3 }),
      hold: num("Seconds held zoomed in; default 0.6.", { minimum: 0, maximum: 5 }),
    },
    required: ["clipId", "time"],
    kind: "edit",
    run: (a) => punchZoom(a.clipId, us(a.time), { amount: a.amount, hold: a.hold }),
  },
  {
    name: "vertical_gaming_layout",
    label: "Montou o layout vertical",
    description:
      "Vertical 1080x1920 for Shorts, TikTok and Reels. With a facecam clip: camera on the top third, gameplay below, both cropped to fit. Without: the gameplay centered over a blurred copy. Applies to every clip of the same media.",
    input: { gameplayClipId: str("Gameplay clip."), facecamClipId: str("Webcam clip, on a track above the gameplay.") },
    required: ["gameplayClipId"],
    kind: "edit",
    run: (a) => verticalGamingLayout(a.gameplayClipId, a.facecamClipId),
  },
  {
    name: "search_sounds",
    quiet: true,
    label: "Buscou sons",
    description: "Find audio: Creative Commons music and sound effects from the web, or Cena's built-in effects that work offline. Licenses that require credit are flagged; export_video lists the credits.",
    input: {
      category: oneOf(["music", "sound_effect", "builtin"], "Kind of sound."),
      query: str("Search terms, usually in English. Not used for builtin."),
      commercial: bool("Only licenses that allow commercial use. Default true."),
    },
    required: ["category"],
    kind: "direct",
    async run(a) {
      if (a.category === "builtin") {
        const builtins = await window.api.libraryBuiltins();
        for (const b of builtins) sounds.set(`builtin:${b.id}`, { path: b.path });
        return { results: builtins.map((b) => ({ id: `builtin:${b.id}`, title: b.name })) };
      }
      if (!a.query) throw new Error("Informe query.");
      const res = await window.api.librarySearch({ query: a.query, category: a.category, commercial: a.commercial ?? true });
      for (const item of res.results) sounds.set(item.id, { item });
      return { total: res.total, results: res.results.map((r) => ({ id: r.id, title: r.title, creator: r.creator, license: r.license, needsCredit: r.needsCredit, duration: r.duration })) };
    },
  },
  {
    name: "add_sound",
    label: "Adicionou um som",
    description: "Download a sound found with search_sounds and put it on the timeline. Use update_clip to set its volume and trim_clip to fit it.",
    input: { soundId: str("Id from search_sounds."), start: seconds("Default: the playhead.") },
    required: ["soundId"],
    kind: "direct",
    async run(a) {
      const sound = sounds.get(a.soundId);
      if (!sound) throw new Error(`Som não encontrado: ${a.soundId}. Use search_sounds antes.`);
      const path = sound.path ?? (await window.api.libraryDownload(sound.item!));
      const id = await addAudio(path, sound.item, a.start === undefined ? undefined : us(a.start));
      if (!id) throw new Error("Não foi possível adicionar o som.");
      return describeId(id);
    },
  },
  {
    name: "ai_voice",
    label: "Narração com voz de IA",
    description:
      "Speak a sentence with the AI voice (Brazilian Portuguese, offline) and put it on an audio track at start (default: the playhead), with the sentence on screen unless captions is false. For a narrated hook (voice over a preview of the scene, then the scene), use narrated_hook instead.",
    input: { text: str("What the voice says, in the creator's words."), start: seconds("Default: the playhead."), speed: num("Speech speed, 0.7 to 1.5; default 1.", { minimum: 0.6, maximum: 1.6 }), captions: bool("Show the sentence on screen; default true.") },
    required: ["text"],
    kind: "direct",
    async run(a) {
      const out = await addNarration(a.text, { start: a.start === undefined ? undefined : us(a.start), speed: a.speed, captions: a.captions !== false });
      return { ...describeId(out.audioId), seconds: +(out.duration / 1e6).toFixed(2), textId: out.textId };
    },
  },
  {
    name: "narrated_hook",
    label: "Gancho narrado",
    description:
      "The narrated hook for Shorts and videos: the AI voice says the creator's sentence (\"Olha o que aconteceu quando…\") while pieces of the video play behind it (muted, slower, a bit darker, the sentence on screen); then the real moment plays. It opens room at 'at' (default 0) by moving everything after it forward. 'teaser' are timeline ranges, in seconds BEFORE the hook goes in, whose picture plays behind the voice (default: what comes right after 'at', so the payoff is previewed and then shown). Pick teaser ranges with get_frame or find_highlights when the creator asks for other parts. Check the result with get_frame.",
    input: {
      text: str("What the voice says."),
      at: seconds("Where the hook goes; default 0."),
      teaser: { type: "array", description: "Ranges [start, end] in seconds of the current timeline.", items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 } },
      speed: num("Speech speed; default 1.", { minimum: 0.6, maximum: 1.6 }),
      teaserSpeed: num("Speed of the preview behind the voice; default 0.6.", { minimum: 0.25, maximum: 1 }),
      captions: bool("Sentence on screen; default true."),
    },
    required: ["text"],
    kind: "direct",
    async run(a) {
      const out = await narratedHook(a.text, {
        at: a.at === undefined ? 0 : us(a.at),
        teaser: Array.isArray(a.teaser) ? a.teaser.map((r: number[]) => [us(r[0]), us(r[1])] as [number, number]) : undefined,
        speed: a.speed,
        teaserSpeed: a.teaserSpeed,
        captions: a.captions !== false,
      });
      return { hookStart: out.start / 1e6, realMomentStarts: +(out.end / 1e6).toFixed(2), voiceSeconds: +(out.voiceDuration / 1e6).toFixed(2), audioId: out.audioId, textId: out.textId, previewClips: out.teaserIds };
    },
  },
  {
    name: "export_video",
    label: "Exportando o vídeo",
    description:
      "Render the timeline to a file. Formats: h264 (.mp4, default, plays everywhere), hevc (.mp4, smaller), av1 (.mp4, smallest, slow without a GPU), vp9 (.webm), prores (.mov, for further editing, huge), gif (.gif, silent, short clips only), mp3 and wav (the sound alone). Lasts about as long as the video or more, so it usually answers with a jobId. Edits made after it starts are not included.",
    input: {
      path: str("Absolute path of the file; its extension must match the format."),
      format: oneOf(EXPORT_FORMATS.map((f) => f.id), "Default h264."),
      quality: oneOf(["high", "recommended", "small"], "Default recommended."),
      gpu: bool("Encode on the graphics card when it can (h264, hevc, av1). Default false."),
      normalizeLoudness: bool("Bring the final mix to -14 LUFS, the YouTube loudness. Default false; good for gameplay and commentary."),
      direct: bool("Default true: untouched stretches go straight through FFmpeg. False sends every frame through the compositor (much slower; only to compare results)."),
      overwrite: bool("Replace an existing file. Ask the user first."),
    },
    required: ["path"],
    kind: "job",
    async run(a, job) {
      const format = exportFormat((a.format ?? "h264") as ExportFormatId);
      absolute(a.path, new RegExp(`\\.${format.ext}$`, "i"), `.${format.ext}`);
      await refuseOverwrite(a.path, a.overwrite);
      await whenAllTracksReady();
      const { project, setPlaying } = ed();
      setPlaying(false);
      const abort = new AbortController();
      let done = 0;
      let total = 0;
      job.progress(() => (total ? `${Math.round((done / total) * 100)}% (${done} de ${total} quadros)` : null));
      job.onCancel(() => abort.abort());
      const res = await exportProject(project, {
        outPath: a.path,
        format: format.id,
        quality: (a.quality ?? "recommended") as ExportQuality,
        gpu: Boolean(a.gpu),
        normalize: Boolean(a.normalizeLoudness),
        pieces: a.direct !== false,
        signal: abort.signal,
        onProgress: (d, t) => {
          done = d;
          total = t;
        },
      });
      const credits = creditsText(project);
      return { path: res.path, frames: res.frames, directFrames: res.direct ?? 0, overlayFrames: res.overlay ?? 0, ...(credits ? { creditsRequired: credits } : {}) };
    },
  },
  {
    name: "get_job",
    quiet: true,
    label: "Acompanhou uma tarefa",
    description: "Status of a long task. Waits up to `wait` seconds for it to finish, then answers with its result or progress.",
    input: { jobId: str("Job id."), wait: num("Seconds to wait; default 30, at most 45.", { minimum: 0, maximum: 45 }) },
    required: ["jobId"],
    kind: "direct",
    async run(a) {
      const job = jobs.get(a.jobId);
      if (!job) throw new Error(`Tarefa não encontrada: ${a.jobId}.`);
      return settle(job, (a.wait ?? 30) * 1000);
    },
  },
  {
    name: "cancel_job",
    label: "Cancelou uma tarefa",
    description: "Cancel a long task.",
    input: { jobId: str("Job id.") },
    required: ["jobId"],
    kind: "direct",
    run(a) {
      const job = jobs.get(a.jobId);
      if (!job) throw new Error(`Tarefa não encontrada: ${a.jobId}.`);
      job.cancel();
      return { cancelling: job.status === "running" };
    },
  },
  {
    name: "studio_send_project",
    label: "Mandou o projeto ao Estúdio",
    description:
      "Send the project open in the editor to the Cena Studio, where its agents write the title, description, tags and chapters (metadata) and make the thumbnails, and the video waits for the user's approval before anything goes to YouTube. By default the project is rendered exactly as you edited it (agents: [\"metadata\", \"thumbnail\"]); add \"assemble\" (and \"cut\", \"audio\", \"edit\") only if the user wants the studio's own edit instead of yours. Save the project first. To make several videos from one long recording, build and send each one as its own project with the same `series` name: their thumbnails are made different from each other. Returns the studio video id.",
    input: {
      brief: str("What the user asked for this video, in their words, plus anything the metadata and thumbnail agents should know (game, what happens in it, who is in it)."),
      title: str("Working title of this video in the studio (the agents still suggest the YouTube title)."),
      series: str("Name shared by videos made from the same recording or meant to be released together, e.g. \"GTA corridas 13/11\"."),
      agents: list(oneOf(["cut", "audio", "edit", "metadata", "thumbnail", "assemble"], "A studio agent."), 'Agents that work on it. Default ["metadata", "thumbnail"].'),
    },
    kind: "direct",
    async run(a) {
      const { project, projectPath, dirty } = ed();
      if (dirty || !projectPath) throw new Error("Salve o projeto antes (save_project com path), para o Estúdio ficar com esta versão.");
      if (!(await window.api.studioAvailable())) throw new Error("O Estúdio não está disponível nesta janela do Cena.");
      const agents = Array.isArray(a.agents) && a.agents.length ? a.agents : ["metadata", "thumbnail"];
      const id = await window.api.studioCall("sendFromEditor", { project, projectPath, title: a.title ?? null, series: a.series ?? null, brief: { text: String(a.brief ?? ""), stops: [], agents } });
      return { videoId: id, agents, note: "No Estúdio, o vídeo é renderizado e fica esperando a aprovação do usuário. Nada vai ao YouTube sem ela." };
    },
  },
  {
    name: "studio_videos",
    label: "Leu os vídeos do Estúdio",
    description: "List the videos in the Cena Studio: status of each agent, suggested title, thumbnail texts, release date, whether the user approved it and whether it is on YouTube.",
    input: {},
    kind: "direct",
    async run() {
      if (!(await window.api.studioAvailable())) throw new Error("O Estúdio não está disponível nesta janela do Cena.");
      return { videos: await window.api.studioCall("overviewForAgent") };
    },
  },
  {
    name: "studio_schedule",
    label: "Programou os lançamentos",
    description:
      "Plan when studio videos come out on YouTube: in the order given, one every `everyDays` days from `start`, at `time` or at the channel's best hour. Only the date is set: each video is sent to YouTube (as private, published by YouTube at that time) after the user approves it in the studio, by themselves. Ask the user for the plan if they did not say it.",
    input: {
      videoIds: list(num("Studio video id."), "Videos in release order."),
      start: str("First release day, YYYY-MM-DD. Default: tomorrow."),
      everyDays: num("Days between releases (1 = every day, 2 = every other day).", { minimum: 1, maximum: 30 }),
      time: str('"HH:MM" (24 h, the computer\'s time zone) or "best" for the channel\'s best hour. Default "best".'),
    },
    required: ["videoIds"],
    kind: "direct",
    async run(a) {
      if (!(await window.api.studioAvailable())) throw new Error("O Estúdio não está disponível nesta janela do Cena.");
      const planned = await window.api.studioCall("scheduleSeries", a.videoIds, { start: a.start, everyDays: a.everyDays ?? 2, time: a.time ?? "best" });
      return { planned: planned.map((p: { id: number; title: string; at: number }) => ({ ...p, at: new Date(p.at).toLocaleString("pt-BR") })), note: "Cada vídeo ainda precisa ser aprovado pelo usuário no Estúdio." };
    },
  },
  {
    name: "save_project",
    label: "Salvou o projeto",
    description: "Save the project to its file, or to `path`. A project that was never saved needs a path.",
    input: { path: str("Absolute path of the .cena file."), overwrite: bool("Replace another existing file. Ask the user first.") },
    kind: "direct",
    async run(a) {
      const { project, projectPath, markSaved } = ed();
      const target = a.path ?? projectPath;
      if (!target) throw new Error("Este projeto ainda não tem arquivo. Informe path.");
      absolute(target, /\.cena$/i, ".cena");
      if (a.path && a.path !== projectPath) await refuseOverwrite(a.path, a.overwrite);
      const saved = await window.api.saveProject(project, target);
      if (saved) markSaved(saved);
      return { path: saved };
    },
  },
  {
    name: "open_project",
    label: "Abriu um projeto",
    description: "Open a .cena project, replacing the current one.",
    input: { path: str("Absolute path of the .cena file."), discardChanges: bool("Lose unsaved changes in the current project. Ask the user first.") },
    required: ["path"],
    kind: "direct",
    async run(a) {
      absolute(a.path, /\.cena$/i, ".cena");
      refuseDiscard(a.discardChanges);
      const { path, data } = await window.api.readProject(a.path);
      if (data?.version !== 1 || !Array.isArray(data.tracks)) throw new Error("Arquivo de projeto inválido.");
      ed().loadProject(data, path);
      // A project opened from outside (the studio, the AI) is shown, even when the start screen was up.
      window.dispatchEvent(new Event("cena:project-opened"));
      return { name: ed().project.name, duration: sec(projectDuration(ed().project)) };
    },
  },
  {
    name: "new_project",
    label: "Criou um projeto",
    description: "Start an empty project, replacing the current one.",
    input: { discardChanges: bool("Lose unsaved changes in the current project. Ask the user first.") },
    kind: "direct",
    run(a) {
      refuseDiscard(a.discardChanges);
      ed().newProject();
      return { name: ed().project.name };
    },
  },
  {
    name: "get_preferences",
    quiet: true,
    label: "Leu as preferências",
    description: "The user's saved editing preferences (style, formats, habits), remembered between conversations. Follow them unless the user asks otherwise.",
    input: {},
    kind: "direct",
    run: async () => ({ preferences: await window.api.memoryList() }),
  },
  {
    name: "remember_preference",
    label: "Guardou uma preferência",
    description:
      'Save a lasting editing preference in one short sentence in the user\'s language, e.g. "Legendas sempre amarelas com contorno preto" or "Os vídeos são verticais 1080×1920 para TikTok". Only for habits that apply to future videos, not one-off requests. A preference with the same text replaces the old one; to change one, forget it first.',
    input: { text: str("The preference, one sentence.") },
    required: ["text"],
    kind: "direct",
    run: async (a) => ({ preferences: await window.api.memoryAdd(a.text) }),
  },
  {
    name: "forget_preference",
    label: "Esqueceu uma preferência",
    description: "Delete saved preferences that no longer apply, by id (from get_preferences).",
    input: { ids: list(str("Preference id."), "Preferences to delete.") },
    required: ["ids"],
    kind: "direct",
    run: async (a) => ({ preferences: await window.api.memoryRemove(a.ids) }),
  },
];

// --- Running tools -------------------------------------------------------------------------

function validated(tool: Tool, args: Args): Args {
  check(args, { type: "object", properties: tool.input, required: tool.required }, tool.name);
  return args;
}

interface Job {
  id: string;
  title: string;
  status: "running" | "done" | "failed";
  result?: unknown;
  error?: string;
  finished: Promise<void>;
  progress(): string | null;
  cancel(): void;
}

const NO_JOB: JobControl = { progress() {}, onCancel() {} };
/** A call answers before common client timeouts (60 s); slower work continues as a job. */
const CALL_WAIT = 45_000;
const JOBS_KEPT = 20;
const jobs = new Map<string, Job>();

function startJob(tool: Tool, args: Args) {
  const job: Job = { id: uid("job"), title: tool.label, status: "running", finished: Promise.resolve(), progress: () => null, cancel() {} };
  const control: JobControl = {
    progress: (read) => (job.progress = read),
    onCancel: (cancel) => (job.cancel = cancel),
  };
  job.finished = Promise.resolve()
    .then(() => tool.run(args, control))
    .then(
      (result) => {
        job.status = "done";
        job.result = result;
      },
      (err: Error) => {
        job.status = "failed";
        job.error = err.name === "AbortError" || /Cancelado/.test(err.message) ? "Cancelado." : err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
      },
    );
  jobs.set(job.id, job);
  for (const id of [...jobs.keys()].slice(0, -JOBS_KEPT)) if (jobs.get(id)!.status !== "running") jobs.delete(id);
  return job;
}

/** The job's outcome if it ends within `wait`; otherwise how to follow it. */
async function settle(job: Job, wait: number) {
  let timer = 0;
  await Promise.race([job.finished, new Promise((resolve) => (timer = window.setTimeout(resolve, wait)))]);
  clearTimeout(timer);
  if (job.status === "failed") throw new Error(job.error);
  if (job.status === "done") return job.result;
  return { status: "running", jobId: job.id, task: job.title, progress: job.progress(), next: "Call get_job with this jobId." };
}

export const toolInfo = (): AgentToolInfo[] =>
  TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: { type: "object", properties: t.input, ...(t.required ? { required: t.required } : {}) },
  }));

export const toolLabel = (name: string) => TOOLS.find((t) => t.name === name)?.label ?? name;
export const isQuietTool = (name: string) => Boolean(TOOLS.find((t) => t.name === name)?.quiet);

/** Run a tool and return MCP content; throws with a message for the AI when it fails. */
export async function callTool(name: string, args: Args): Promise<AgentContent[]> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Ferramenta desconhecida: ${name}.`);
  validated(tool, args);
  const output =
    tool.kind === "edit" ? oneUndoStep(() => tool.run(args, NO_JOB)) : tool.kind === "job" ? await settle(startJob(tool, args), CALL_WAIT) : await tool.run(args, NO_JOB);
  if (output instanceof Images) {
    return [{ type: "text", text: JSON.stringify(output.info) }, ...output.images.map((image) => ({ type: "image" as const, ...image }))];
  }
  return [{ type: "text", text: JSON.stringify(output ?? { ok: true }) }];
}

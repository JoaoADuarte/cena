import { useEditor } from "./store";
import { aiErrorMessage, runAiTask } from "./ai";
import { findSegment, sourceDuration, uid } from "./model/project";
import { toSeconds, SECOND } from "./model/time";
import type { Material, Segment } from "./model/types";

type Tool = NonNullable<Material["derived"]>["tool"];

const SUFFIX: Record<Tool, string> = {
  removeBackground: "sem fundo",
  removeObjects: "editada",
  reverse: "invertido",
  denoise: "sem ruído",
  enhance: "melhorado",
  voice: "voz melhorada",
};

/** Audio tasks work on the sound alone; a video's sound is detached to its own clip first. */
function audioClipFor(id: string) {
  const c = mediaClip(id);
  const audioId = c.material.hasAudio ? (c.track.kind === "audio" ? id : useEditor.getState().detachAudio(id)) : null;
  if (!audioId) throw new Error("Este clipe não tem som.");
  return audioId;
}

function status(text: string | null, clearAfter = 5000) {
  useEditor.getState().setStatus(text);
  if (text) setTimeout(() => useEditor.getState().status === text && useEditor.getState().setStatus(null), clearAfter);
}

/** The clip, its track and its material, or null. */
function clip(id: string) {
  const { project } = useEditor.getState();
  const found = findSegment(project, id);
  const material = found?.segment.materialId ? project.materials[found.segment.materialId] : undefined;
  return found && material ? { ...found, material } : null;
}

function mediaClip(id: string) {
  const c = clip(id);
  if (!c) throw new Error("Este clipe não tem mídia para processar.");
  return c;
}

/**
 * Register a processed file as a material derived from the clip's current one and swap it in.
 * Processed videos/audio cover only the clip's source range, so the clip then starts at 0 in them.
 */
export async function adoptDerived(segment: Segment, material: Material, path: string, tool: Tool) {
  const info = await window.api.probe(path);
  const coversRange = material.kind !== "image";
  const derived: Material = {
    id: uid("mat"),
    ...info,
    name: `${material.name.replace(/ \([^)]*\)$/, "")} (${SUFFIX[tool]})`,
    derived: { from: material.id, tool, sourceStart: coversRange ? segment.sourceStart : 0 },
  };
  useEditor.getState().replaceMaterial(segment.id, derived, coversRange ? 0 : segment.sourceStart);
}

const range = (s: Segment) => ({ sourceStart: toSeconds(s.sourceStart), sourceDuration: toSeconds(sourceDuration(s)) });

/** Run a processing task on a clip and adopt the result. */
async function process(id: string, tool: Tool, run: (c: ReturnType<typeof mediaClip>) => Promise<{ path: string }>) {
  const c = mediaClip(id);
  const res = await run(c);
  await adoptDerived(c.segment, c.material, res.path, tool);
}

/** The tasks themselves; they throw on failure. The buttons use the versions below, which report in the status bar. */
export const clipTasks = {
  removeBackground: (id: string) =>
    process(id, "removeBackground", ({ segment, material }) =>
      runAiTask("Remover fundo", "removeBackground", {
        path: material.path,
        kind: material.kind === "image" ? "image" : "video",
        width: material.width ?? 0,
        height: material.height ?? 0,
        fps: material.fps ?? useEditor.getState().project.fps,
        hasAudio: material.hasAudio,
        ...range(segment),
      }),
    ),

  reverse: (id: string) =>
    process(id, "reverse", ({ segment, material }) => runAiTask("Inverter", "reverse", { path: material.path, hasVideo: material.hasVideo, hasAudio: material.hasAudio, ...range(segment) })),

  enhance: (id: string) =>
    process(id, "enhance", ({ segment, material }) =>
      runAiTask("Melhorar qualidade", "enhance", { path: material.path, width: material.width ?? 1280, height: material.height ?? 720, hasAudio: material.hasAudio, ...range(segment) }),
    ),

  /** Noise reduction works on audio; a video's sound is detached to its own clip first. */
  async denoise(id: string) {
    await process(audioClipFor(id), "denoise", ({ segment, material }) => runAiTask("Reduzir ruído", "denoise", { path: material.path, ...range(segment) }));
  },

  /** Commentary polish (noise, EQ, compressor, loudness) on the clip's sound. */
  async voice(id: string) {
    await process(audioClipFor(id), "voice", ({ segment, material }) => runAiTask("Melhorar voz", "voice", { path: material.path, ...range(segment) }));
  },

  /** Freeze the frame under the playhead for 3 seconds. */
  async freezeFrame(id: string) {
    const c = clip(id);
    const { playhead } = useEditor.getState();
    if (!c || c.track.kind !== "video" || !c.material.hasVideo || c.material.kind === "image") throw new Error("Selecione um clipe de vídeo para congelar o quadro.");
    if (playhead <= c.segment.start || playhead >= c.segment.start + c.segment.duration) throw new Error("Ponha o cursor sobre o clipe selecionado.");
    const seconds = toSeconds(c.segment.sourceStart + (playhead - c.segment.start) * c.segment.speed);
    const path = await window.api.extractFrame(c.material.path, seconds);
    const info = await window.api.probe(path);
    const still: Material = { id: uid("mat"), ...info, name: `${c.material.name.replace(/ \([^)]*\)$/, "")} (quadro congelado)` };
    useEditor.getState().insertFreezeFrame(id, still, 3 * SECOND);
  },
};

/** A task for a button: success and failure go to the status bar. */
const reported = (title: string, done: string | null, task: (id: string) => Promise<void>) => async (id: string) => {
  try {
    await task(id);
    if (done) status(done);
  } catch (err) {
    const message = aiErrorMessage(err);
    status(message ? `${title}: ${message}` : `${title}: cancelado.`, 8000);
  }
};

export const removeBackground = reported("Remover fundo", "Fundo removido.", clipTasks.removeBackground);
export const reverseClip = reported("Inverter", "Clipe invertido.", clipTasks.reverse);
export const enhanceClip = reported("Melhorar qualidade", "Qualidade melhorada.", clipTasks.enhance);
export const denoiseClip = reported("Reduzir ruído", "Ruído reduzido.", clipTasks.denoise);
export const freezeFrame = reported("Congelar quadro", null, clipTasks.freezeFrame);
export const enhanceVoice = reported("Melhorar voz", "Voz melhorada.", clipTasks.voice);

/** Clips among `ids` whose sound can be processed: audio clips, and videos still playing their own sound. */
export function soundClips(ids: string[]): string[] {
  const { project } = useEditor.getState();
  return [...new Set(ids)].filter((id) => {
    const found = findSegment(project, id);
    const material = found?.segment.materialId ? project.materials[found.segment.materialId] : undefined;
    return Boolean(found && !found.track.locked && material?.hasAudio && (found.track.kind === "audio" || found.segment.volume > 0));
  });
}

/**
 * Voice polish or noise reduction on several clips, one after another (the processing runs one job at a time).
 * Progress and the outcome go to the status bar; stops early if the user cancels.
 */
export async function processSound(ids: string[], tool: "voice" | "denoise"): Promise<{ done: number; errors: string[]; cancelled: boolean }> {
  const title = tool === "voice" ? "Melhorar voz" : "Reduzir ruído";
  const targets = soundClips(ids);
  const errors: string[] = [];
  let done = 0;
  let cancelled = false;
  if (!targets.length) {
    status(`${title}: selecione um ou mais clipes com som.`, 6000);
    return { done, errors, cancelled };
  }
  for (const [i, id] of targets.entries()) {
    if (!findSegment(useEditor.getState().project, id)) continue;
    if (targets.length > 1) status(`${title}: clipe ${i + 1} de ${targets.length}…`, 3_600_000);
    try {
      await clipTasks[tool](id);
      done++;
    } catch (err) {
      const message = aiErrorMessage(err);
      if (!message) {
        cancelled = true;
        break;
      }
      errors.push(message);
    }
  }
  const what = tool === "voice" ? "Voz melhorada" : "Ruído reduzido";
  if (cancelled) status(`${title}: cancelado${done ? ` (${done} clipe(s) já prontos)` : ""}.`, 8000);
  else if (errors.length) status(`${title}: ${done} de ${targets.length} prontos. Erro: ${errors[0]}`, 10000);
  else status(targets.length > 1 ? `${what} em ${done} clipes.` : `${what}.`);
  return { done, errors, cancelled };
}

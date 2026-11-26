import type { AudioClipJob, ExportJob } from "../api";
import type { Micros, Project } from "../model/types";
import { projectDuration, sourceDuration } from "../model/project";
import { SECOND } from "../model/time";
import { drawFrame, drawOverlay, framesNeeded, sourceSecondsAt } from "./compositor";
import { MediaPool, imageReady, seekExact } from "./mediaPool";
import { SequentialFrames, sharedCanvas } from "./sequentialFrames";
import { overlayBox, planExport, type ExportPiece } from "./exportPlan";
import { ensureProjectFonts } from "../fonts";
import { exportFormat, type ExportFormatId, type ExportQuality } from "../exportFormats";

export interface ExportOptions {
  outPath: string;
  /** H.264 MP4 unless told otherwise. */
  format?: ExportFormatId;
  quality: ExportQuality;
  /** Encode on the graphics card when it can. */
  gpu?: boolean;
  /** Platform loudness (-14 LUFS) for the final mix. */
  normalize?: boolean;
  onProgress?: (done: number, total: number) => void;
  /** False: every frame goes through the compositor, with no direct pieces (used to compare the two ways). */
  pieces?: boolean;
  /** All frames are encoded; the file is being put together. */
  onFinishing?: () => void;
  signal?: AbortSignal;
}

let exporting = false;

/** Attribution lines for library audio used on the timeline whose license asks for credit. */
export function creditsText(project: Project): string {
  const used = new Set(project.tracks.flatMap((t) => t.segments.map((s) => s.materialId)));
  return Object.values(project.materials)
    .filter((m) => used.has(m.id) && m.credit?.needsCredit)
    .map((m) => `"${m.credit!.title}" — ${m.credit!.creator} (${m.credit!.license})${m.credit!.url ? ` ${m.credit!.url}` : ""}`)
    .join("\n");
}

/** Audio for every audible clip, mixed by FFmpeg in the main process. */
export function audioPlan(project: Project): AudioClipJob[] {
  const clips: AudioClipJob[] = [];
  for (const track of project.tracks) {
    if (track.muted || track.kind === "text") continue;
    for (const s of track.segments) {
      const m = s.materialId ? project.materials[s.materialId] : undefined;
      const silent = s.volume <= 0 && !s.keyframes.volume?.some((k) => k.value > 0);
      if (!m || !m.hasAudio || silent) continue;
      clips.push({
        path: m.path,
        sourceStart: s.sourceStart,
        sourceDuration: sourceDuration(s),
        start: s.start,
        duration: s.duration,
        speed: s.speed,
        volume: s.volume,
        fadeIn: s.fadeIn,
        fadeOut: s.fadeOut,
        keepPitch: s.keepPitch,
        ...(s.keyframes.volume?.length ? { volumeKeyframes: s.keyframes.volume.map((k) => ({ time: k.time / SECOND, value: k.value })) } : {}),
      });
    }
  }
  return clips;
}

/** Seek every visible media element (both clips during a transition) to the frame for `t`. */
async function prepareFrame(project: Project, t: Micros, pool: MediaPool, frames?: SequentialFrames) {
  const waits: Promise<unknown>[] = [];
  const active = new Set<string>();
  for (const track of project.tracks) {
    if (track.hidden || track.kind !== "video") continue;
    for (const s of framesNeeded(track, t)) {
      const m = s.materialId ? project.materials[s.materialId] : undefined;
      if (!m) continue;
      if (m.kind === "image") waits.push(imageReady(pool.image(m)));
      else if (m.hasVideo) {
        const seconds = sourceSecondsAt(s, t, m);
        active.add(s.id);
        const seek = () => seekExact(pool.video(s, m), seconds);
        waits.push(frames ? frames.prepare(s, m, seconds).then((ready) => (ready ? undefined : seek())) : seek());
      }
    }
  }
  frames?.retain(active);
  await Promise.all(waits);
}

/** Seek and composite one frame; shared by export and the smoke test. */
export async function renderFrameAt(ctx: CanvasRenderingContext2D, project: Project, t: Micros, pool: MediaPool, frames?: SequentialFrames) {
  await prepareFrame(project, t, pool, frames);
  drawFrame(ctx, project, t, pool);
}

/** Direct pieces run in the background while this renders the others, then everything is joined. */
async function exportInPieces(
  project: Project,
  job: ExportJob,
  pieces: ExportPiece[],
  total: number,
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  pool: MediaPool,
  frames: SequentialFrames,
  options: ExportOptions,
): Promise<{ path: string; direct: number; overlay: number }> {
  /** Frames that never went through the compositor, and frames that took only their texts from it. */
  const made = { direct: 0, overlay: 0 };
  const aborted = () => options.signal?.aborted;
  const stop = () => void window.api.exportCancel();
  options.signal?.addEventListener("abort", stop);
  // Texts over untouched video: only the rectangle they can reach is drawn here and sent along.
  const boxes = pieces.map((piece) => {
    if (piece.kind !== "direct" || !piece.overlay) return null;
    const box = overlayBox(project, piece);
    if (!box) piece.overlay = false;
    return box;
  });
  let layer: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
  await window.api.hybridStart(job, pieces);
  const report = () => void window.api.hybridProgress().then((done) => options.onProgress?.(Math.min(done, total), total));
  const timer = setInterval(report, 400);
  const render = async (index: number, piece: ExportPiece) => {
    await window.api.hybridBeginRender(index);
    for (let i = 0; i < piece.frames; i++) {
      if (aborted()) throw new DOMException("Exportação cancelada", "AbortError");
      await renderFrameAt(ctx, project, Math.round(((piece.from + i) * SECOND) / project.fps), pool, frames);
      await window.api.hybridCanvasFrame(canvas.id);
    }
    await window.api.hybridEndRender();
    frames.retain(new Set());
  };
  const overlay = async (index: number, piece: ExportPiece) => {
    const box = boxes[index]!;
    if (!layer) {
      const made = sharedCanvas(project.width, project.height, { alpha: true });
      const made2d = made.getContext("2d", { willReadFrequently: true });
      if (!made2d) return render(index, piece);
      layer = { canvas: made, ctx: made2d };
    }
    const top = layer;
    if (!(await window.api.hybridBeginOverlay(index, box))) return render(index, piece);
    try {
      for (let i = 0; i < piece.frames; i++) {
        if (aborted()) throw new DOMException("Exportação cancelada", "AbortError");
        drawOverlay(top.ctx, project, Math.round(((piece.from + i) * SECOND) / project.fps));
        await window.api.hybridOverlayFrame(top.canvas.id, box);
      }
      await window.api.hybridEndRender();
      made.overlay += piece.frames;
    } catch (err) {
      if (aborted()) throw err;
      // Footage FFmpeg could not take this way: the compositor does the whole piece.
      console.warn("[export] overlay piece redone by the compositor:", err);
      await window.api.hybridDropRender(index);
      await render(index, piece);
    }
  };
  try {
    for (const [index, piece] of pieces.entries()) {
      if (piece.kind === "render") await render(index, piece);
      else if (piece.overlay) await overlay(index, piece);
    }
    const failed = await window.api.hybridDirectDone();
    if (aborted()) throw new DOMException("Exportação cancelada", "AbortError");
    // Footage FFmpeg cannot take as it is (transparency, HDR…) still gets there through the compositor.
    for (const index of failed) await render(index, pieces[index]);
    for (const [index, piece] of pieces.entries()) if (piece.kind === "direct" && !piece.overlay && !failed.includes(index)) made.direct += piece.frames;
    options.onProgress?.(total, total);
    options.onFinishing?.();
    return { path: await window.api.hybridFinish(), ...made };
  } finally {
    clearInterval(timer);
    options.signal?.removeEventListener("abort", stop);
    (layer as { canvas: HTMLCanvasElement } | null)?.canvas.remove();
  }
}

/**
 * Render the timeline frame by frame with the same compositor as the preview, streaming raw
 * RGBA to FFmpeg. Returns the output path.
 */
export async function exportProject(project: Project, options: ExportOptions): Promise<{ path: string; frames: number; direct?: number; overlay?: number }> {
  const duration = projectDuration(project);
  if (duration <= 0) throw new Error("A timeline está vazia.");
  if (Object.values(project.materials).some((m) => m.pending)) throw new Error("As faixas de áudio da gravação ainda estão sendo preparadas. Tente de novo em alguns segundos.");
  // The main process keeps one session; a second start would kill the export in progress.
  if (exporting) throw new Error("Já existe uma exportação em andamento.");
  exporting = true;
  let pool: MediaPool | null = null;
  let frames: SequentialFrames | undefined;
  let canvas: HTMLCanvasElement | undefined;
  try {
    await ensureProjectFonts(project);
    const { width, height, fps } = project;
    const total = Math.max(1, Math.round((duration / SECOND) * fps));
    canvas = sharedCanvas(width, height, { alpha: false });
    const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    if (!ctx) throw new Error("Canvas 2D indisponível");

    const format = exportFormat(options.format ?? "h264");
    const audio = audioPlan(project);
    if (format.audioOnly && !audio.length) throw new Error("A timeline não tem som para exportar.");
    const job: ExportJob = { outPath: options.outPath, width, height, fps, format: format.id, quality: options.quality, gpu: options.gpu, duration, audio: format.silent ? [] : audio, normalize: options.normalize };
    pool = new MediaPool(true);
    frames = new SequentialFrames(pool);

    const pieces = options.pieces !== false && (format.id === "h264" || format.id === "hevc") ? planExport(project) : null;
    if (pieces) {
      const out = await exportInPieces(project, job, pieces, total, ctx, canvas, pool, frames, options);
      return { ...out, frames: total };
    }

    await window.api.exportStart(job);
    // Audio formats need no pictures: FFmpeg works straight from the timeline's sound.
    for (let i = 0; i < (format.audioOnly ? 0 : total); i++) {
      if (options.signal?.aborted) throw new DOMException("Exportação cancelada", "AbortError");
      const t = Math.round((i * SECOND) / fps);
      await renderFrameAt(ctx, project, t, pool, frames);
      await window.api.exportCanvasFrame(canvas.id);
      options.onProgress?.(i + 1, total);
    }
    const path = await window.api.exportFinish();
    if (format.audioOnly) options.onProgress?.(total, total);
    return { path, frames: format.audioOnly ? 0 : total };
  } catch (err) {
    await window.api.exportCancel();
    throw err;
  } finally {
    exporting = false;
    frames?.destroy();
    pool?.destroy();
    canvas?.remove();
  }
}

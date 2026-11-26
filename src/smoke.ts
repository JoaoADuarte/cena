import { useEditor } from "./store";
import { MediaPool, mediaUrl } from "./engine/mediaPool";
import { runAiTask } from "./ai";
import type { AiTasks } from "./api";
import { splitCaptions } from "./model/captions";
import { exportProject, renderFrameAt } from "./engine/exporter";
import { SequentialFrames, sharedCanvas } from "./engine/sequentialFrames";
import { planExport } from "./engine/exportPlan";
import { EXPORT_FORMATS, exportFormat, type ExportFormatId } from "./exportFormats";
import { BLEND_MODES, EFFECTS, MASK_TYPES, SHAPE_KINDS, TRANSITIONS, TRANSITION_SHAPES } from "./model/types";
import { googleCatalog, installedFonts, loadCustomFonts, loadGoogleFont } from "./fonts";
import { FILTERS } from "./model/types";
import { TEMPLATES, applyTemplate } from "./templates";
import { freezeFrame } from "./clipActions";
import { callTool } from "./agentTools";
import { MAX_ZOOM, MIN_ZOOM, whenTracksReady } from "./store";
import { flushAutosave, useAutosave } from "./autosave";
import { selectedIds, useUi, withLinked } from "./ui";
import { createMask, valueAt } from "./model/project";
import { parseSubtitles } from "./model/subtitles";
import { convertCapcutDraft } from "./importers/capcut";
import { findSegment, projectDuration } from "./model/project";
import { SECOND } from "./model/time";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assert: ${message}`);
}

/** The AI connection: the real protocol end to end, then each kind of tool through `callTool`. */
async function agentChecks(media: { video: string; audio: string; output: string }) {
  const s = () => useEditor.getState();
  const mcp = await window.api.smokeMcp();
  assert(mcp.wrongToken === 401 && mcp.noToken === 401, `token refused ${mcp.wrongToken}/${mcp.noToken}`);
  assert(mcp.fromBrowser === 403 && mcp.rebinding === 403, `browser refused ${mcp.fromBrowser}/${mcp.rebinding}`);
  assert(mcp.version === "2025-06-18" && mcp.hasInstructions && mcp.notificationStatus === 202, `handshake ${JSON.stringify(mcp)}`);
  assert((mcp.tools as number) >= 30 && mcp.unknownToolCode === -32602 && mcp.toolErrorFlag === true, `tools ${JSON.stringify(mcp)}`);
  assert(String(mcp.projectText).includes('"tracks"'), "get_project over MCP");

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const [first] = await callTool(name, args);
    return JSON.parse((first as { text: string }).text);
  };
  const fails = async (name: string, args: Record<string, unknown>, match: RegExp) => {
    const error = await callTool(name, args).then(
      () => "",
      (err: Error) => err.message,
    );
    assert(match.test(error), `${name} should fail with ${match}, got "${error}"`);
  };
  const steps = () => s().past.length;

  s().newProject();
  const { materials, failed } = await call("import_media", { paths: [media.video, "C:\\nao-existe.mp4"] });
  assert(materials.length === 1 && failed.length === 1, "import reports the failed file");
  const video = materials[0].id;
  const a = await call("add_clip", { materialId: video });
  const b = await call("add_clip", { materialId: video, sourceStart: 1, duration: 1 });
  assert(a.end === 3 && b.start === 3 && b.end === 4 && b.sourceStart === 1, `add_clip ${JSON.stringify(b)}`);

  // Overlay video (HyperFrames renders) lands on a new track above the main one and comes off cleanly.
  const over = await call("add_clip", { materialId: video, overlay: true, start: 0.5, duration: 1 });
  const overTrack = findSegment(s().project, over.id)!.track;
  const mainTrack = s().project.tracks.filter((t) => t.kind === "video").at(-1)!;
  assert(overTrack !== mainTrack && s().project.tracks.indexOf(overTrack) < s().project.tracks.indexOf(mainTrack) && over.start === 0.5, "overlay clip goes above the main track");
  await call("undo");
  assert(!findSegment(s().project, over.id) && s().project.tracks.filter((t) => t.kind === "video").length === 1, "overlay undo");

  // Removing media takes its clips with it in one step; undo brings both back.
  const [extra] = (await call("import_media", { paths: [media.audio] })).materials;
  await call("add_clip", { materialId: extra.id, start: 0 });
  const removal = await call("remove_media", { materialIds: [extra.id] });
  assert(removal.clipsRemoved === 1 && !s().project.materials[extra.id] && !s().project.tracks.some((t) => t.kind === "audio"), "remove_media");
  await call("undo");
  assert(s().project.materials[extra.id] && s().project.tracks.some((t) => t.kind === "audio"), "remove_media undo");
  await call("remove_media", { materialIds: [extra.id] });

  // Bad input is refused with a useful message and changes nothing.
  const before = steps();
  await fails("update_clip", { clipIds: [a.id], filter: { type: "nope" } }, /use um destes/);
  await fails("update_clip", { clipIds: [a.id], transfrom: {} }, /campo desconhecido/);
  await fails("update_clip", { clipIds: ["missing"], volume: 0.5 }, /não encontrado/);
  await fails("add_text", {}, /falta "content"/);
  assert(steps() === before, "refused calls leave no undo step");

  // Each edit is a single undo step, even when it does several things.
  const text = await call("add_text", { content: "Olá", start: 0.5, duration: 2, style: { color: "#ffd400", fontSize: 120 }, transform: { y: 0.5 } });
  assert(steps() === before + 1 && text.text === "Olá", "add_text is one step");
  const look = await call("update_clip", { clipIds: [a.id, b.id], filter: { type: "noir" }, adjust: { contrast: 1.2 }, speed: 2 });
  assert(look.updated[0].filter === "noir" && look.updated[1].speed === 2 && steps() === before + 2, `update_clip ${JSON.stringify(look)}`);
  assert(findSegment(s().project, a.id)!.segment.duration === 1.5 * SECOND, "speed changes the length");
  await call("undo");
  assert(findSegment(s().project, a.id)!.segment.filter === null && findSegment(s().project, b.id)!.segment.speed === 1, "undo restores every clip");

  // A failed batch leaves nothing behind; a good one is one step.
  const beforeBatch = steps();
  await fails("batch", { operations: [{ tool: "add_marker", args: { time: 1 } }, { tool: "delete_clips", args: { clipIds: ["missing"] } }] }, /Operação 2/);
  assert(s().project.markers.length === 0 && steps() === beforeBatch, "failed batch rolled back");
  await fails("batch", { operations: [{ tool: "export_video", args: {} }] }, /não pode ser usada/);
  await call("batch", { operations: [{ tool: "add_marker", args: { time: 2.5, label: "fim" } }, { tool: "add_effect", args: { clipIds: [a.id], type: "vignette", intensity: 0.5 } }] });
  assert(steps() === beforeBatch + 1 && s().project.markers.length === 1, "batch is one step");

  // Cutting ranges keeps every track in sync, and linked pieces stay paired.
  await call("detach_audio", { clipId: a.id });
  await call("remove_ranges", { ranges: [{ start: 1, end: 1.5 }, { start: 1.4, end: 2 }] });
  const project = await call("get_project");
  assert(project.duration === 3, `remove_ranges duration ${project.duration}`);
  assert(project.markers[0].time === 1.5, `marker follows ${project.markers[0].time}`);
  const main = project.tracks.filter((t: { kind: string }) => t.kind === "video").at(-1);
  assert(main.clips.length === 3 && main.clips[1].sourceStart === 2, `cut clips ${JSON.stringify(main.clips)}`);
  const audioClips = project.tracks.find((t: { kind: string }) => t.kind === "audio").clips;
  assert(audioClips.length === 2 && audioClips[1].start === 1, `cut audio ${JSON.stringify(audioClips)}`);
  assert(main.clips[0].linkId !== main.clips[1].linkId && main.clips[0].linkId === audioClips[0].linkId, "each piece keeps its own link");
  const deleted = await call("delete_clips", { clipIds: [main.clips[0].id] });
  assert(deleted.deleted.length === 2, `delete takes only the partner: ${deleted.deleted}`);
  // With the magnet the other tracks close up too: the text piece over the deleted clip went with it, the rest moved back.
  const texts = s().project.tracks.filter((tr) => tr.kind === "text").flatMap((tr) => tr.segments);
  assert(!findSegment(s().project, text.id) && texts.length === 1 && texts[0].start === 0, `texts follow the delete ${JSON.stringify(texts.map((x) => [x.start, x.duration]))}`);

  const order = main.clips.slice(1).map((c: { id: string }) => c.id).reverse();
  await call("reorder_clips", { trackId: main.id, clipIds: order });
  assert(findSegment(s().project, order[0])!.segment.start === 0, "reorder");
  await fails("reorder_clips", { trackId: main.id, clipIds: order.slice(1) }, /todos os clipes/);

  await call("split_clip", { time: 0.5, clipId: order[0] });
  await fails("split_clip", { time: 99 }, /Nada para dividir/);
  await fails("set_transition", { clipId: texts[0].id, type: "fade" }, /corte entre dois/);
  const faded = await call("set_transition", { clipId: order[0], type: "circle", duration: 0.4 });
  assert(faded.transition === "circle", "set_transition");

  const template = await call("apply_template", { templateId: "title", start: 0 });
  assert(template.added.length === 2, "apply_template");
  const moved = await call("add_overlay", { type: "sticker", sticker: { emoji: "🔥", size: 200 }, start: 0, duration: 1 });
  await call("set_keyframes", { clipId: moved.id, property: "scale", keyframes: [{ time: 0, value: 0.5, easing: "easeOut" }, { time: 1, value: 1 }] });
  await fails("set_keyframes", { clipId: moved.id, property: "scale", keyframes: [{ time: 5, value: 1 }] }, /passa do fim/);
  const captions = await call("add_captions", { lines: [{ start: 0, end: 1, text: "um" }, { start: 0.5, end: 2, text: "sobreposta" }], style: { color: "#ffd400" } });
  assert(captions.added === 1 && captions.skipped === 1, `add_captions ${JSON.stringify(captions)}`);

  // The AI sees what the export will show.
  const frames = await callTool("get_frame", { times: [0.2, 1], maxWidth: 320 });
  assert(frames.length === 3 && frames[1].type === "image" && frames[1].data.length > 1000, "get_frame images");

  // Files are protected, and an export answers with its path.
  await fails("export_video", { path: "video.mp4" }, /caminho completo/);
  await fails("export_video", { path: media.output }, /já existe/);
  await fails("save_project", { path: media.output.replace(/\.mp4$/, ".txt") }, /\.cena/);
  await fails("new_project", {}, /não salvas/);
  const out = media.output.replace(/\.mp4$/, "-ia.mp4");
  const exported = await call("export_video", { path: out, quality: "small" });
  const info = await window.api.probe(exported.path);
  assert(info.hasVideo && info.duration > 0, "AI export is playable");
  const projectFile = media.output.replace(/\.mp4$/, ".cena");
  await call("save_project", { path: projectFile });
  await call("update_project", { name: "Mudado" });
  await fails("open_project", { path: projectFile }, /não salvas/);
  await call("open_project", { path: projectFile, discardChanges: true });
  assert(s().project.name !== "Mudado" && s().projectPath === projectFile, "open_project");

  // The in-app assistant knows where it works and whether Claude Code is here (it is not run in the self test).
  const chat = await window.api.chatStatus();
  assert(/assistente$/.test(chat.workspace), `chat workspace ${chat.workspace}`);

  const job = await call("list_catalog");
  assert(job.filters.length === 16 && job.templates.length === TEMPLATES.length, "catalog");
  return { protocol: mcp.version, tools: mcp.tools, exported: exported.frames, claudeCode: Boolean(chat.claude) };
}

/** Gameplay tools on an OBS-style recording, through the same calls the AI makes. */
async function gamingChecks(media: { obs: string; pcm: string; output: string }) {
  const s = () => useEditor.getState();
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const [first] = await callTool(name, args);
    return JSON.parse((first as { text: string }).text);
  };
  s().newProject();
  const out: Record<string, unknown> = {};

  // Multi-track import: the second audio track becomes its own material and comes along, linked.
  const { materials } = await call("import_media", { paths: [media.obs] });
  assert(materials.length === 1, "obs import returns the recording");
  const recording = s().project.materials[materials[0].id];
  assert(recording.audioCompanions?.length === 1, `obs tracks ${JSON.stringify(recording.audioCompanions)}`);
  const video = await call("add_clip", { materialId: recording.id });
  const voiceTrack = s().project.tracks.find((t) => t.kind === "audio")!;
  const voice = voiceTrack.segments[0];
  const videoSeg = findSegment(s().project, video.id)!.segment;
  assert(
    voice && voice.linkId && voice.linkId === videoSeg.linkId && Math.abs(voice.duration - videoSeg.duration) < SECOND / 10 && voice.start === videoSeg.start,
    `voice track linked to the video: ${JSON.stringify({ voice: voice && { link: voice.linkId, start: voice.start, duration: voice.duration }, video: { link: videoSeg.linkId, start: videoSeg.start, duration: videoSeg.duration } })}`,
  );
  out.obsTracks = Object.keys(s().project.materials).length;

  // Ducking: the game dips while the voice talks (0-2 s, 4-6 s) and comes back in the pause.
  const duck = await call("duck_audio", { voiceClipId: voice.id, level: 0.2 });
  const game = findSegment(s().project, video.id)!.segment;
  const at = (t: number) => valueAt(game, "volume", t * SECOND);
  assert(duck.clipsDucked === 1 && Math.abs(at(1) - 0.2) < 0.01 && Math.abs(at(3) - 1) < 0.01 && Math.abs(at(5) - 0.2) < 0.01, `ducking ${at(1)}/${at(3)}/${at(5)}`);
  out.ducking = { phrases: duck.phrases, keyframes: game.keyframes.volume!.length };

  // Volume curves, 200% and loudness normalization all reach FFmpeg.
  await call("update_clip", { clipIds: [voice.id], volume: 1.6 });
  const exported = await call("export_video", { path: media.output.replace(/\.mp4$/, "-gamer.mp4"), quality: "small", normalizeLoudness: true });
  const env = await window.api.audioEnvelope(exported.path, 0, 6, 0.5);
  assert(env.db.length >= 11 && Math.max(...env.db) > -30, `gamer export audio ${env.db}`);
  out.export = exported.frames;

  // Silence cut on the voice: the 2-4 s pause goes, minus breathing room, on every track.
  await call("clear_ducking", { clipIds: [video.id] });
  const fullLength = (await call("get_project")).duration;
  const silences = await call("remove_silences", { clipId: voice.id, minSilence: 0.7, padding: 0.15 });
  const duration = (await call("get_project")).duration;
  assert(silences.cuts === 1 && duration > 4.1 && duration < 4.5, `silences ${JSON.stringify(silences)} → ${duration}`);
  out.silences = { removed: silences.removedSeconds, duration };
  await call("undo");
  const restored = (await call("get_project")).duration;
  assert(restored === fullLength, `silence cut undo: ${restored} vs ${fullLength}`);

  const scenes = await call("detect_scenes", { clipId: video.id });
  assert(scenes.scenes === 2 && Math.abs(scenes.times[0] - 3) < 0.2, `scenes ${JSON.stringify(scenes)}`);
  const highlights = await call("find_highlights", { clipId: video.id, count: 2, window: 1 });
  assert(highlights.moments.length === 2 && s().project.markers.some((m) => m.label === "Destaque 1"), `highlights ${JSON.stringify(highlights)}`);
  out.markers = s().project.markers.length;

  await call("punch_zoom", { clipId: video.id, time: 1, amount: 1.4 });
  const zoomed = findSegment(s().project, video.id)!.segment;
  assert(Math.abs(valueAt(zoomed, "scale", 1.3 * SECOND) - 1.4) < 0.01 && Math.abs(valueAt(zoomed, "scale", 0.5 * SECOND) - 1) < 0.01, "punch zoom");

  // Vertical with a facecam: camera on top, gameplay below.
  const cam = await call("add_clip", { materialId: recording.id, overlay: true, start: 0 });
  await call("vertical_gaming_layout", { gameplayClipId: video.id, facecamClipId: cam.id });
  const { project } = s();
  const placed = project.tracks.flatMap((t) => t.segments).filter((x) => x.materialId === recording.id);
  assert(project.width === 1080 && project.height === 1920 && placed.every((x) => Math.abs(x.transform.y + 2 / 3) < 0.01), "vertical layout (same media: both clips are the camera)");
  await call("vertical_gaming_layout", { gameplayClipId: video.id });
  assert(s().project.backgroundMode === "blur", "vertical without facecam");

  for (const id of ["gg", "kill", "epic"]) assert((await call("apply_template", { templateId: id, start: 0 })).added.length > 0, `template ${id}`);
  const snapshot = s().project;

  // Importing from the interface doesn't wait for the extra tracks: they arrive later and link to
  // the clips already on the timeline. Here a PCM recording, copied into WAV without conversion.
  s().newProject();
  const [pcm] = await s().importFiles([media.pcm]);
  const placeholder = s().project.materials[s().project.materials[pcm.id].audioCompanions?.[0] ?? ""];
  assert(pcm.audioTracks === 2 && placeholder?.pending === true, "import does not wait: the extra track is a placeholder at once");
  const early = s().addMaterialToTimeline(pcm.id)!;
  assert(s().project.tracks.some((t) => t.kind === "audio" && t.segments.some((x) => x.materialId === placeholder.id)), "the placeholder goes on the timeline with the video");
  await whenTracksReady(pcm.id);
  const separated = s().project.materials[pcm.id].audioCompanions ?? [];
  const wav = s().project.materials[separated[0]];
  const partner = s().project.tracks.flatMap((t) => t.segments).find((x) => x.materialId === wav?.id);
  assert(!wav?.pending && wav?.id === placeholder.id && wav?.path.endsWith(".wav") && partner?.linkId === findSegment(s().project, early)!.segment.linkId && partner.start === 0, `late tracks link to placed clips: ${wav?.path}`);
  // What the preview does with it: the browser decodes 24-bit WAV.
  const decoded = await new AudioContext().decodeAudioData(await (await fetch(mediaUrl(wav.path))).arrayBuffer());
  assert(Math.abs(decoded.duration - 3) < 0.1, `wav decodes: ${decoded.duration}`);
  out.pcmTrack = wav.name;

  // Voice polish runs the FFmpeg chain in the worker and swaps the clip's sound.
  s().loadProject(JSON.parse(JSON.stringify(snapshot)), null);
  await call("process_clip", { clipId: voice.id, action: "enhanceVoice" });
  const polished = s().project.materials[findSegment(s().project, voice.id)!.segment.materialId!];
  assert(polished.derived?.tool === "voice", "enhance voice");
  out.voice = polished.name;
  return out;
}

/** Mean absolute difference (0-255) over every channel of two RGBA frames. */
function meanDiff(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4 * 7) {
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    n += 3;
  }
  return sum / n;
}

/**
 * Export reads frames in order; the preview seeks a <video>. They must show the same picture at the same time,
 * so each sample is rendered both ways.
 */
async function decodeChecks(samples: Record<string, string>) {
  const s = () => useEditor.getState();
  const out: Record<string, unknown> = {};
  for (const [name, path] of Object.entries(samples)) {
    s().newProject();
    const [material] = await s().importFiles([path]);
    const id = s().addMaterialToTimeline(material.id)!;
    const project = s().project;
    const canvas = document.createElement("canvas");
    canvas.width = project.width = material.width!;
    canvas.height = project.height = material.height!;
    const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true })!;
    const pool = new MediaPool(true);
    const frames = new SequentialFrames(pool);
    const seekPool = new MediaPool(true);
    const grab = () => ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const fps = project.fps;
    const diffs: number[] = [];
    let sequential = 0;
    const end = Math.min(findSegment(project, id)!.segment.duration, 2 * SECOND);
    for (let i = 0; i * (SECOND / fps) < end - SECOND / 10; i += 3) {
      const t = Math.round((i * SECOND) / fps);
      const seg = findSegment(project, id)!.segment;
      const ready = await frames.prepare(seg, material, (seg.sourceStart + t) / SECOND);
      if (ready) sequential++;
      await renderFrameAt(ctx, project, t, seekPool);
      // A <video> can report "seeked" before its new frame is drawable; give it time, so this reference is the true frame.
      await new Promise((r) => setTimeout(r, 150));
      await drawOnly(ctx, project, t, seekPool);
      const seeked = new Uint8ClampedArray(grab());
      if (ready) {
        await drawOnly(ctx, project, t, pool);
        diffs.push(meanDiff(grab(), seeked));
      }
    }
    frames.destroy();
    pool.destroy();
    seekPool.destroy();
    const worst = Math.max(0, ...diffs);
    out[name] = { sequential, worst: Math.round(worst * 100) / 100 };
    if (name === "transparent") assert(sequential === 0, "transparent video stays with the browser");
    else {
      assert(sequential > 0, `${name} decoded in order`);
      assert(worst < 1.5, `${name} differs from the preview: ${JSON.stringify(out[name])}`);
    }
  }
  return out;
}

/**
 * Exporting in pieces: plain stretches straight through FFmpeg, the rest from the compositor, joined.
 * The file must match the preview on both kinds of piece and across the joins, with the right length.
 */
async function piecesChecks(samples: Record<string, string>, output: string) {
  const s = () => useEditor.getState();
  s().newProject();
  const [hd] = await s().importFiles([samples.taggedHd]);
  const [alpha] = await s().importFiles([samples.transparent]);
  s().mutate((p) => {
    p.width = 1280;
    p.height = 720;
    p.fps = 30;
  });
  const ids = [hd, hd, hd, alpha, hd, hd].map((m) => s().addMaterialToTimeline(m.id, { start: projectDuration(s().project) })!);
  s().setTransition(ids[1], { type: "fade", duration: SECOND / 2 });
  const textAt = findSegment(s().project, ids[5])!.segment.start + SECOND / 2;
  s().addText(textAt);
  const project = s().project;
  const plan = planExport(project);
  assert(plan && plan.some((p) => p.kind === "direct") && plan.some((p) => p.kind === "render"), `plan mixes both kinds: ${JSON.stringify(plan)}`);
  const total = Math.round((projectDuration(project) / SECOND) * project.fps);
  assert(plan.reduce((sum, p) => sum + p.frames, 0) === total && plan.every((p, i) => i === 0 || p.from === plan[i - 1].from + plan[i - 1].frames), "pieces cover the timeline exactly");

  const out: Record<string, unknown> = { pieces: plan.length, direct: plan.filter((p) => p.kind === "direct").length };
  const gpus = await window.api.exportGpu();
  const canvas = document.createElement("canvas");
  canvas.width = project.width;
  canvas.height = project.height;
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true })!;
  const seekPool = new MediaPool(true);
  const shared = sharedCanvas(project.width, project.height);
  const sharedCtx = shared.getContext("2d", { willReadFrequently: true })!;
  // Middle of each piece, and both sides of every join.
  const probes = [...new Set(plan.flatMap((p) => [p.from, p.from + Math.floor(p.frames / 2), p.from + p.frames - 1]))].filter((n) => n > 0 && n < total - 1);
  const cases: { format: "h264" | "hevc"; gpu: boolean }[] = [{ format: "h264", gpu: false }];
  if (gpus.h264) cases.push({ format: "h264", gpu: true });
  if (gpus.hevc) cases.push({ format: "hevc", gpu: true });
  for (const c of cases) {
    const outPath = output.replace(/\.mp4$/, `-pieces-${c.format}${c.gpu ? "-gpu" : ""}.mp4`);
    const res = await exportProject(project, { outPath, format: c.format, quality: "high", gpu: c.gpu });
    const info = await window.api.probe(res.path);
    assert(info.hasVideo && info.hasAudio && Math.abs(info.duration - projectDuration(project)) < SECOND / 10, `pieces file: ${JSON.stringify(info)} vs ${projectDuration(project)}`);
    let worst = 0;
    for (const n of probes) {
      const t = Math.round((n * SECOND) / project.fps);
      await renderFrameAt(ctx, project, t, seekPool);
      await new Promise((r) => setTimeout(r, 120));
      await drawOnly(ctx, project, t, seekPool);
      const preview = new Uint8ClampedArray(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
      const seconds = (n + 0.5) / project.fps;
      const id = await window.api.decodeOpen(res.path, seconds);
      assert(id, "exported file can be read back");
      const frame = await window.api.decodeFrameTo(id, seconds, shared.id);
      await window.api.decodeClose(id);
      assert(frame, `frame ${n} of the export`);
      const diff = meanDiff(sharedCtx.getImageData(0, 0, shared.width, shared.height).data, preview);
      worst = Math.max(worst, diff);
      assert(diff < 5, `${c.format}${c.gpu ? "/gpu" : ""} frame ${n} differs from the preview by ${diff.toFixed(2)}`);
    }
    out[`${c.format}${c.gpu ? "Gpu" : ""}`] = Math.round(worst * 100) / 100;
  }
  shared.remove();
  seekPool.destroy();
  return out;
}

/** Composite with what is already prepared, without seeking. */
async function drawOnly(ctx: CanvasRenderingContext2D, project: ReturnType<typeof useEditor.getState>["project"], t: number, pool: MediaPool) {
  const { drawFrame } = await import("./engine/compositor");
  drawFrame(ctx, project, t, pool);
}

/** Groups, multi-selection, the assistant's memory, the start screen's project list and voice polish on several clips. */
async function organizeChecks(media: { video: string; obs: string; output: string }) {
  const s = () => useEditor.getState();
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const [first] = await callTool(name, args);
    return JSON.parse((first as { text: string }).text);
  };
  const out: Record<string, unknown> = {};

  // Groups: selected, moved and deleted as one; pasted copies form a new group; undo brings them back.
  s().newProject();
  const a = s().addText(0);
  const b = s().addText(4 * SECOND);
  const c = s().addText(8 * SECOND);
  s().selectMany([a, b]);
  assert(selectedIds().join() === [a, b].join(), "selectMany");
  const group = s().groupSegments(selectedIds())!;
  const seg = (id: string) => findSegment(s().project, id)!.segment;
  assert(group && seg(a).groupId === group && seg(b).groupId === group && !seg(c).groupId, "group made");
  assert(withLinked([a]).sort().join() === [a, b].sort().join(), "a group acts as one");
  s().moveSegments(withLinked([b]), SECOND);
  assert(seg(a).start === SECOND && seg(b).start === 5 * SECOND, `group moves together ${seg(a).start}/${seg(b).start}`);
  s().copySegments([a, b]);
  const pasted = s().pasteSegments(12 * SECOND);
  assert(pasted.length === 2 && seg(pasted[0]).groupId && seg(pasted[0]).groupId === seg(pasted[1]).groupId && seg(pasted[0]).groupId !== group, "pasted copies get their own group");
  assert(s().ungroupSegments([a]) === 2 && !seg(a).groupId && !seg(b).groupId, "ungroup");
  s().undo();
  assert(seg(a).groupId === group, "undo brings the group back");
  out.groups = "ok";

  // The assistant's memory, through the same tools Claude uses.
  await window.api.memoryClear();
  await call("remember_preference", { text: "Legendas sempre amarelas com contorno preto" });
  await call("remember_preference", { text: "legendas sempre amarelas com  contorno preto" });
  await call("remember_preference", { text: "Vídeos verticais 1080×1920" });
  const { preferences } = await call("get_preferences");
  assert(preferences.length === 2, `same preference stored once: ${JSON.stringify(preferences)}`);
  const left = await call("forget_preference", { ids: [preferences[0].id] });
  assert(left.preferences.length === 1 && left.preferences[0].text.startsWith("Vídeos"), "forget preference");
  await window.api.memoryClear();
  out.memory = "ok";

  // Saving puts the project on the start screen, with its length and a cover picture.
  s().newProject();
  const { materials } = await call("import_media", { paths: [media.video] });
  await call("add_clip", { materialId: materials[0].id });
  const file = media.output.replace(/\.mp4$/, "-lobby.cena");
  const saved = await window.api.saveProject(s().project, file);
  assert(saved === file, "project saved");
  const recent = (await window.api.recentProjects()).find((p) => p.path.toLowerCase() === file.toLowerCase());
  assert(recent && !recent.missing && recent.clips === 1 && Math.abs(recent.duration - 3) < 0.1 && recent.cover?.startsWith("data:image/jpeg"), `recent project ${JSON.stringify(recent && { ...recent, cover: Boolean(recent.cover) })}`);
  await window.api.forgetProject(file);
  assert(!(await window.api.recentProjects()).some((p) => p.path.toLowerCase() === file.toLowerCase()), "forget project");
  out.recents = "ok";

  // Every export format: the file exists and holds what it should.
  const formats: Record<string, unknown> = {};
  s().newProject();
  const media3 = await call("import_media", { paths: [media.video] });
  await call("add_clip", { materialId: media3.materials[0].id, duration: 1 });
  const gpus = await window.api.exportGpu();
  const exportAs = async (id: ExportFormatId, gpu: boolean) => {
    const f = exportFormat(id);
    const outPath = media.output.replace(/\.mp4$/, `-fmt-${id}${gpu ? "-gpu" : ""}.${f.ext}`);
    const res = await exportProject(s().project, { outPath, format: id, quality: "small", gpu });
    const info = await window.api.probe(res.path);
    assert(info.hasVideo === !f.audioOnly, `${id} picture: ${JSON.stringify(info)}`);
    assert(info.hasAudio === !f.silent, `${id} sound: ${JSON.stringify(info)}`);
    // A GIF is read back as a picture, which has no length of its own.
    assert(id === "gif" || Math.abs(info.duration - SECOND) < SECOND / 4, `${id} length: ${info.duration}`);
  };
  for (const f of EXPORT_FORMATS) {
    await exportAs(f.id, false);
    if (f.gpu && gpus[f.id as "h264"]) await exportAs(f.id, true);
    formats[f.id] = f.gpu ? (gpus[f.id as "h264"] ?? "cpu") : "ok";
  }
  out.formats = formats;

  // Autosave: a change reaches disk, and this launch's own copy is never offered as lost work.
  for (const r of await window.api.autosaveList()) await window.api.autosaveDiscard(r.id);
  s().addText(0);
  await flushAutosave();
  assert(useAutosave.getState().savedAt !== null && !useAutosave.getState().failed, "autosave written");
  assert((await window.api.autosaveList()).length === 0, "own copy is not offered for recovery");
  out.autosave = "ok";

  // Timeline zoom limits, without drawing the whole ruler.
  s().setZoom(1e9);
  await new Promise((r) => setTimeout(r, 150));
  assert(s().pxPerSecond === MAX_ZOOM, `max zoom ${s().pxPerSecond}`);
  const ticks = document.querySelectorAll(".tick").length;
  assert(ticks > 0 && ticks < 3000, `ruler drawn near the screen only: ${ticks}`);
  s().setZoom(0);
  assert(s().pxPerSecond === MIN_ZOOM, `min zoom ${s().pxPerSecond}`);
  s().setZoom(80);
  out.zoom = { ticks };

  // Voice polish on several clips at once: the recording's own sound and its microphone track.
  s().newProject();
  const obs = await call("import_media", { paths: [media.obs] });
  const clip = await call("add_clip", { materialId: obs.materials[0].id });
  const mic = s().project.tracks.find((t) => t.kind === "audio")!.segments[0];
  const many = await call("process_clip", { clipIds: [clip.id, mic.id], action: "enhanceVoice" });
  const voiced = s().project.tracks.flatMap((t) => t.segments).filter((x) => s().project.materials[x.materialId ?? ""]?.derived?.tool === "voice");
  assert(many.processed === 2 && voiced.length === 2, `voice on two clips: ${JSON.stringify(many)} / ${voiced.length}`);
  out.voiceMany = voiced.length;
  return out;
}

/** Mean absolute red-channel difference between two frames, sampled. */
function frameDiff(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  let d = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4 * 97, n++) d += Math.abs(a[i] - b[i]);
  return d / n;
}

/** Masks, blend modes, blurred background, easing curves, effect keyframes, shapes and stickers. */
async function renderingChecks(leftId: string, rightId: string) {
  const s = () => useEditor.getState();
  const out: Record<string, unknown> = {};
  const canvas = document.createElement("canvas");
  canvas.width = s().project.width;
  canvas.height = s().project.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const pool = new MediaPool(true);
  const sample = async (t: number) => {
    await renderFrameAt(ctx, s().project, t, pool);
    return new Uint8ClampedArray(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
  };
  const lit = (px: Uint8ClampedArray) => {
    let n = 0;
    for (let i = 0; i < px.length; i += 4 * 97) if (px[i] + px[i + 1] + px[i + 2] > 60) n++;
    return n;
  };
  const base = await sample(0.5 * SECOND);

  // Masks: a small ellipse hides most of the frame; inverting it shows most of it again.
  for (const type of MASK_TYPES) {
    s().updateSegment(leftId, (seg) => void (seg.mask = { ...createMask(type), points: [[-0.5, -0.5], [0.5, -0.4], [0, 0.6]] }));
    await sample(0.5 * SECOND);
  }
  s().updateSegment(leftId, (seg) => void (seg.mask = { ...createMask("ellipse"), width: 0.3, height: 0.3, feather: 0.05 }));
  const masked = lit(await sample(0.5 * SECOND));
  s().updateSegment(leftId, (seg) => void (seg.mask!.invert = true));
  const inverted = lit(await sample(0.5 * SECOND));
  assert(masked < lit(base) * 0.4 && inverted > lit(base) * 0.6, `mask lit ${masked}/${inverted} of ${lit(base)}`);
  s().updateSegment(leftId, (seg) => void (seg.mask = null));
  out.masks = { types: MASK_TYPES.length, masked, inverted, full: lit(base) };

  // Blend: a white shape over the clip covers it when normal and leaves it unchanged with multiply.
  const shapeId = s().addOverlay({ shape: { kind: "rectangle", width: 4000, height: 4000, fill: "#ffffff", stroke: "#000", strokeWidth: 0, roundness: 0, sides: 4 } }, 0);
  const normal = await sample(0.5 * SECOND);
  s().updateSegment(shapeId, (seg) => void (seg.blend = "multiply"));
  const multiply = await sample(0.5 * SECOND);
  assert(frameDiff(normal, base) > 30 && frameDiff(multiply, base) < 3, `blend ${frameDiff(normal, base)} / ${frameDiff(multiply, base)}`);
  for (const mode of BLEND_MODES) {
    s().updateSegment(shapeId, (seg) => void (seg.blend = mode));
    await sample(0.5 * SECOND);
  }
  s().deleteSegment(shapeId);
  out.blend = { modes: BLEND_MODES.length };

  // Every shape kind and a sticker render.
  for (const kind of SHAPE_KINDS) {
    const id = s().addOverlay({ shape: { kind, width: 300, height: 200, fill: "#ff0000", stroke: "#fff", strokeWidth: 4, roundness: 0.3, sides: 5 } }, 0);
    await sample(0.5 * SECOND);
    s().deleteSegment(id);
  }
  const stickerId = s().addOverlay({ sticker: { emoji: "🔥", size: 300 } }, 0);
  assert(frameDiff(await sample(0.5 * SECOND), base) > 0.5, "sticker drew nothing");
  s().deleteSegment(stickerId);

  // Blurred background fills the borders around a shrunken clip.
  s().updateSegment(leftId, (seg) => void (seg.transform.scale = 0.5));
  const small = lit(await sample(0.5 * SECOND));
  s().mutate((p) => void (p.backgroundMode = "blur"));
  const filled = lit(await sample(0.5 * SECOND));
  assert(filled > small * 1.5, `blurred background ${small} -> ${filled}`);
  s().mutate((p) => void (p.backgroundMode = "color"));
  s().updateSegment(leftId, (seg) => void (seg.transform.scale = 1));
  out.blurBackground = { small, filled };

  // Easing: "hold" keeps the first value, ease-in lags behind linear at the midpoint.
  s().updateSegment(rightId, (seg) => {
    seg.keyframes.opacity = [
      { time: 0, value: 0, easing: "linear" },
      { time: seg.duration, value: 1 },
    ];
  });
  const mid = (findSegment(s().project, rightId)!.segment.duration) / 2;
  const linear = valueAt(findSegment(s().project, rightId)!.segment, "opacity", mid);
  s().setKeyframeEasing(rightId, 0, "easeIn");
  const easeIn = valueAt(findSegment(s().project, rightId)!.segment, "opacity", mid);
  s().setKeyframeEasing(rightId, 0, [0.2, 0.9, 0.3, 1]);
  const custom = valueAt(findSegment(s().project, rightId)!.segment, "opacity", mid);
  s().setKeyframeEasing(rightId, 0, "hold");
  const hold = valueAt(findSegment(s().project, rightId)!.segment, "opacity", mid);
  assert(Math.abs(linear - 0.5) < 0.01 && easeIn < 0.4 && custom > 0.7 && hold === 0, `easing ${linear} ${easeIn} ${custom} ${hold}`);
  s().updateSegment(rightId, (seg) => void delete seg.keyframes.opacity);
  out.easing = { linear, easeIn: Math.round(easeIn * 100) / 100, custom: Math.round(custom * 100) / 100, hold };

  // Effect intensity keyframes.
  s().addEffect(rightId, "bw");
  const fx = findSegment(s().project, rightId)!.segment.effects.find((e) => e.type === "bw")!;
  const channel = `fx:${fx.id}` as const;
  s().updateSegment(rightId, (seg) => void (seg.keyframes[channel] = [{ time: 0, value: 0 }, { time: seg.duration, value: 1 }]));
  const seg = findSegment(s().project, rightId)!.segment;
  assert(valueAt(seg, channel, 0) === 0 && valueAt(seg, channel, seg.duration) === 1, "effect keyframes");
  await sample(2 * SECOND);
  s().removeEffect(rightId, fx.id);
  assert(!findSegment(s().project, rightId)!.segment.keyframes[channel], "effect keyframes removed with the effect");
  out.effectKeyframes = "ok";

  // Filters: every look renders; Noir turns the frame gray.
  for (const type of FILTERS) {
    s().updateSegment(leftId, (x) => void (x.filter = { type, intensity: 0.8 }));
    await sample(0.5 * SECOND);
  }
  s().updateSegment(leftId, (x) => void (x.filter = { type: "noir", intensity: 1 }));
  const noir = await sample(0.5 * SECOND);
  let chroma = 0;
  for (let i = 0; i < noir.length; i += 4 * 97) chroma += Math.abs(noir[i] - noir[i + 1]) + Math.abs(noir[i + 1] - noir[i + 2]);
  assert(chroma / (noir.length / (4 * 97)) < 4, `noir filter left color (${chroma})`);
  s().updateSegment(leftId, (x) => void (x.filter = null));

  // Temperature warms the frame (more red than blue); sharpen renders.
  s().updateSegment(leftId, (x) => void (x.adjust.temperature = 1));
  const warm = await sample(0.5 * SECOND);
  let redMinusBlue = 0;
  let baseRedMinusBlue = 0;
  for (let i = 0; i < warm.length; i += 4 * 97) {
    redMinusBlue += warm[i] - warm[i + 2];
    baseRedMinusBlue += base[i] - base[i + 2];
  }
  assert(redMinusBlue > baseRedMinusBlue, "temperature warms the frame");
  s().updateSegment(leftId, (x) => void Object.assign(x.adjust, { temperature: 0, tint: 0.5, sharpen: 0.7 }));
  await sample(0.5 * SECOND);
  s().updateSegment(leftId, (x) => void Object.assign(x.adjust, { tint: 0, sharpen: 0 }));

  // Mirror changes the picture; an adjustment layer at zero brightness blacks out what is below it.
  s().flip([leftId], "x");
  assert(frameDiff(await sample(0.5 * SECOND), base) > 5, "mirror");
  s().flip([leftId], "x");
  const adj = s().addOverlay({ adjustLayer: true }, 0);
  s().updateSegment(adj, (x) => void (x.adjust.brightness = 0));
  assert(lit(await sample(0.5 * SECOND)) < 5, "adjustment layer darkens everything below");
  s().deleteSegment(adj);
  out.grading = { filters: FILTERS.length, noirChroma: Math.round(chroma), warmth: Math.round(redMinusBlue - baseRedMinusBlue) };

  // Templates insert animated overlays and render.
  for (const t of TEMPLATES) {
    if (t.project) continue;
    const before = s().project.tracks.flatMap((tr) => tr.segments).length;
    applyTemplate(t);
    const added = s().project.tracks.flatMap((tr) => tr.segments).length - before;
    assert(added === t.build().length, `template ${t.id} added ${added}`);
    await sample(s().playhead + 0.6 * SECOND);
    s().undo();
  }
  out.templates = TEMPLATES.length;
  pool.destroy();
  return out;
}

/** Toolbar edits: delete left/right of the playhead, freeze frame, main-track magnet and linking. */
async function toolbarChecks(leftId: string, rightId: string) {
  const s = () => useEditor.getState();
  const seg = (id: string) => findSegment(s().project, id)!.segment;
  const before = JSON.stringify(s().project);
  const out: Record<string, unknown> = {};

  s().setPlayhead(0.5 * SECOND);
  const oldEnd = seg(leftId).start + seg(leftId).duration;
  assert(s().deleteToPlayhead(leftId, "left") && seg(leftId).start === 0.5 * SECOND && seg(leftId).start + seg(leftId).duration === oldEnd, "delete left");
  s().compactMainTrack();
  assert(seg(leftId).start === 0, "magnet closes the gap at the start");
  s().undo();

  s().setPlayhead(1 * SECOND);
  assert(s().deleteToPlayhead(leftId, "right") && seg(leftId).start + seg(leftId).duration === SECOND, "delete right");
  s().undo();

  const rightStart = seg(rightId).start;
  s().setPlayhead(0.75 * SECOND);
  s().select(leftId);
  await freezeFrame(leftId);
  const still = s().selectedId!;
  const stillMaterial = s().project.materials[seg(still).materialId!];
  assert(stillMaterial?.kind === "image" && seg(still).duration === 3 * SECOND && seg(rightId).start === rightStart + 3 * SECOND, "freeze frame");
  out.freezeFrame = { image: `${stillMaterial.width}x${stillMaterial.height}` };
  s().undo();

  const audioId = s().detachAudio(leftId)!;
  assert(seg(audioId).linkId && seg(audioId).linkId === seg(leftId).linkId, "detached audio is linked");
  useUi.getState().set({ link: true });
  assert(withLinked([leftId]).includes(audioId), "linked clips select together");
  s().undo();

  while (JSON.stringify(s().project) !== before && s().past.length) s().undo();
  assert(JSON.stringify(s().project) === before, "toolbar checks undo cleanly");
  return out;
}

/** Group move, ripple, copy/paste, paste attributes, detach audio and markers. Leaves the project as it found it. */
function timelineChecks(leftId: string, rightId: string, videoMaterialId: string) {
  const s = () => useEditor.getState();
  const before = JSON.stringify(s().project);
  const all = () => s().project.tracks.flatMap((t) => t.segments);
  const seg = (id: string) => findSegment(s().project, id)!.segment;

  const textId = s().addText(0);
  s().moveSegments([textId], SECOND);
  assert(seg(textId).start === SECOND, "group move");

  s().copySegments([leftId]);
  const [pasted] = s().pasteSegments(10 * SECOND);
  assert(pasted && seg(pasted).start === 10 * SECOND && seg(pasted).materialId === videoMaterialId, "paste");
  s().updateSegment(leftId, (x) => void (x.transform.rotation = 33));
  s().copySegments([leftId]);
  assert(s().pasteAttributes([pasted]) === 1 && seg(pasted).transform.rotation === 33, "paste attributes");

  const audioId = s().detachAudio(pasted);
  assert(audioId && seg(pasted).volume === 0 && findSegment(s().project, audioId)!.track.kind === "audio", "detach audio");

  const rightStart = seg(rightId).start;
  const leftDuration = seg(leftId).duration;
  s().deleteSegments([leftId], true);
  assert(seg(rightId).start === rightStart - leftDuration, "ripple delete pulls the next clip back");
  s().undo();
  s().trimSegment(leftId, "end", seg(leftId).duration - SECOND / 2, true);
  assert(seg(rightId).start === rightStart - SECOND / 2, "ripple trim");

  const markerId = s().addMarker(SECOND);
  s().updateMarker(markerId, { label: "Corte" });
  assert(s().project.markers[0]?.label === "Corte", "markers");

  // Undo everything done here (each action is one step) and confirm nothing leaked.
  while (JSON.stringify(s().project) !== before && s().past.length) s().undo();
  assert(JSON.stringify(s().project) === before, "timeline checks undo cleanly");
  return { segmentsAfterUndo: all().length };
}

/** Installed fonts, the Google catalog and a Google download. Network parts are reported, not asserted. */
async function fontChecks() {
  const out: Record<string, unknown> = {};
  try {
    const local = await installedFonts();
    out.installed = local.length;
    out.installedSample = local.slice(0, 3);
  } catch (err) {
    out.installed = `error: ${(err as Error).message}`;
  }
  try {
    out.googleCatalog = (await googleCatalog()).length;
    await loadGoogleFont("Bebas Neue");
    out.googleLoaded = document.fonts.check('40px "Bebas Neue"');
  } catch (err) {
    out.google = `error: ${(err as Error).message}`;
  }
  out.custom = (await loadCustomFonts()).length;
  return out;
}

function subtitleChecks() {
  const srt = "1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>Olá</i> mundo\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nSegunda, linha\r\ncom quebra\r\n";
  const a = parseSubtitles("x.srt", srt);
  assert(a.length === 2 && a[0].text === "Olá mundo" && a[1].start === 3 && a[1].text.includes("\n"), `srt ${JSON.stringify(a)}`);
  const ass = "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,{\\b1}Oi,{\\i1} tudo\\Nbem?";
  const b = parseSubtitles("x.ass", ass);
  assert(b.length === 1 && b[0].start === 1.5 && b[0].text === "Oi, tudo\nbem?", `ass ${JSON.stringify(b)}`);
  return { srt: a.length, ass: b.length };
}

/** Draw a video file's frame at `seconds` onto a transparent canvas and count pixels that are not opaque. */
async function transparentPixels(file: string, seconds: number) {
  const v = document.createElement("video");
  v.muted = true;
  v.crossOrigin = "anonymous";
  v.src = mediaUrl(file);
  await new Promise((resolve, reject) => {
    v.onloadeddata = resolve;
    v.onerror = () => reject(new Error("video did not load"));
  });
  v.currentTime = seconds;
  await new Promise((resolve) => (v.onseeked = resolve));
  const c = document.createElement("canvas");
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(v, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  let count = 0;
  for (let i = 3; i < data.length; i += 4 * 13) if (data[i] < 250) count++;
  v.removeAttribute("src");
  v.load();
  return count;
}

/** Model-backed features; only run with CENA_SMOKE_AI=1 because they download models. */
async function aiChecks(video: string, image: string, speech: string | null) {
  const out: Record<string, unknown> = {};
  const call = <T extends keyof AiTasks>(task: T, params: AiTasks[T]["params"]) => runAiTask(`smoke ${task}`, task, params);

  let t = performance.now();
  const bg = await call("removeBackground", { path: video, kind: "video", width: 640, height: 360, fps: 30, sourceStart: 0.5, sourceDuration: 1, hasAudio: true });
  const bgInfo = await window.api.probe(bg.path);
  assert(bgInfo.kind === "video" && bgInfo.hasAudio && Math.abs(bgInfo.duration - SECOND) < 0.1 * SECOND, `bg video ${JSON.stringify(bgInfo)}`);
  const transparent = await transparentPixels(bg.path, 0.5);
  assert(transparent > 0, "background-removed video decodes with alpha");
  out.removeBackground = { seconds: Math.round((performance.now() - t) / 100) / 10, transparentSamples: transparent };

  t = performance.now();
  const mask = document.createElement("canvas");
  mask.width = 800;
  mask.height = 600;
  const m = mask.getContext("2d")!;
  m.fillStyle = "#000";
  m.fillRect(0, 0, 800, 600);
  m.fillStyle = "#fff";
  m.fillRect(490, 370, 210, 150);
  const inpaint = await call("removeObjects", { path: image, maskPng: mask.toDataURL("image/png").split(",")[1] });
  const inpaintInfo = await window.api.probe(inpaint.path);
  assert(inpaintInfo.kind === "image" && inpaintInfo.width === 800, "object removal output");
  out.removeObjects = { seconds: Math.round((performance.now() - t) / 100) / 10 };

  if (speech) {
    t = performance.now();
    const info = await window.api.probe(speech);
    const { segments } = await call("transcribe", {
      audio: [{ path: speech, sourceStart: 0, sourceDuration: info.duration, start: 0, duration: info.duration, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0 }],
      duration: info.duration,
      language: "pt",
      quality: "fast",
    });
    const text = segments.map((x) => x.text).join(" ");
    assert(/legenda/i.test(text), `transcription: ${text}`);
    const added = useEditor.getState().addCaptions(splitCaptions(segments, 6), true);
    assert(added > 0 && useEditor.getState().project.tracks.some((tr) => tr.role === "captions"), "captions track");
    out.transcribe = { seconds: Math.round((performance.now() - t) / 100) / 10, text, captions: added };
  }

  t = performance.now();
  const rev = await call("reverse", { path: video, sourceStart: 0.5, sourceDuration: 1.5, hasVideo: true, hasAudio: true });
  const den = await call("denoise", { path: video, sourceStart: 0, sourceDuration: 2 });
  const enh = await call("enhance", { path: video, sourceStart: 0, sourceDuration: 1, width: 640, height: 360, hasAudio: true });
  const [revInfo, denInfo, enhInfo] = await Promise.all([rev.path, den.path, enh.path].map((p) => window.api.probe(p)));
  assert(revInfo.kind === "video" && denInfo.kind === "audio" && enhInfo.width === 1280, "reverse/denoise/enhance outputs");
  out.processing = { seconds: Math.round((performance.now() - t) / 100) / 10, reverse: revInfo.duration / SECOND, enhance: `${enhInfo.width}x${enhInfo.height}` };

  try {
    const res = await window.api.librarySearch({ query: "whoosh", category: "sound_effect", commercial: true });
    assert(res.results.length > 0, "openverse results");
    const file = await window.api.libraryDownload(res.results[0]);
    const info = await window.api.probe(file);
    out.soundLibrary = { results: res.total, downloaded: info.kind };
  } catch (err) {
    // Network search is best-effort in the self test.
    out.soundLibrary = { error: (err as Error).message };
  }
  return out;
}

/** End-to-end self test driven by `npm run smoke`; reports to the main process and exits. */
export async function runSmokeTest() {
  const checks: Record<string, unknown> = {};
  try {
    const media = await window.api.smokeSetup();
    const s = () => useEditor.getState();

    const [video, audio] = await s().importFiles([media.video, media.audio]);
    assert(video && audio, "import returned two materials");
    assert(video.hasVideo && video.hasAudio && video.width === 640, "video probe");
    assert(Math.abs(video.duration - 3 * SECOND) < 0.1 * SECOND, `video duration ${video.duration}`);
    assert(s().project.width === 640 && s().project.height === 360, "canvas adopts first video size");
    checks.import = "ok";

    const videoSeg = s().addMaterialToTimeline(video.id)!;
    s().addMaterialToTimeline(audio.id, { start: SECOND });
    const audioTrack = s().project.tracks.find((t) => t.kind === "audio");
    assert(audioTrack?.segments[0]?.start === SECOND, "audio placed at 1s on an audio track");

    s().splitAt(1.5 * SECOND, videoSeg);
    const main = findSegment(s().project, videoSeg)!.track;
    assert(main.segments.length === 2, "split produced two segments");
    const [left, right] = main.segments;
    assert(left.duration === 1.5 * SECOND && right.sourceStart === 1.5 * SECOND, "split ranges");
    checks.split = "ok";

    s().updateSegment(right.id, (seg) => {
      seg.speed = 2;
      seg.duration = seg.duration / 2;
    });
    assert(projectDuration(s().project) === Math.max(2.25 * SECOND, 3 * SECOND), `duration after speed ${projectDuration(s().project)}`);
    checks.speed = "ok";

    const textId = s().addText(0);
    s().updateSegment(textId, (seg) => void (seg.text!.content = "Cena smoke"));
    s().setPlayhead(0);
    s().toggleKeyframe(textId, "x");
    s().setPlayhead(2 * SECOND);
    s().setAnimated(textId, "x", 0.5);
    const textSeg = findSegment(s().project, textId)!.segment;
    assert(textSeg.keyframes.x?.length === 2, "two keyframes");
    checks.keyframes = "ok";

    const before = s().project.tracks.flatMap((t) => t.segments).length;
    s().deleteSegment(textId);
    s().undo();
    assert(s().project.tracks.flatMap((t) => t.segments).length === before, "undo restores deleted text");
    s().redo();
    s().undo();
    checks.undo = "ok";

    // The composited frame must contain the test pattern and the canvas must stay untainted.
    const canvas = document.createElement("canvas");
    canvas.width = s().project.width;
    canvas.height = s().project.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const pool = new MediaPool(true);
    const sample = async (t: number) => {
      await renderFrameAt(ctx, s().project, t, pool);
      return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    let px = await sample(0.5 * SECOND);
    let lit = 0;
    for (let i = 0; i < px.length; i += 4 * 97) if (px[i] + px[i + 1] + px[i + 2] > 60) lit++;
    assert(lit > 100, `frame looks empty (${lit} lit samples)`);
    checks.compositor = { litSamples: lit };

    // Crop: keeping only the right half of the source must change the frame.
    s().updateSegment(left.id, (seg) => void (seg.crop = { left: 0.5, top: 0, right: 0, bottom: 0 }));
    const cropped = await sample(0.5 * SECOND);
    let cropDiff = 0;
    for (let i = 0; i < cropped.length; i += 4 * 97) cropDiff += Math.abs(cropped[i] - px[i]);
    assert(cropDiff / (cropped.length / (4 * 97)) > 5, `crop had no visible effect (${cropDiff})`);
    s().undo();
    checks.crop = { diff: Math.round(cropDiff) };

    // Effect: black & white on the right half must produce gray pixels.
    s().addEffect(right.id, "bw");
    px = await sample(2 * SECOND);
    let chroma = 0;
    for (let i = 0; i < px.length; i += 4 * 97) chroma += Math.abs(px[i] - px[i + 1]) + Math.abs(px[i + 1] - px[i + 2]);
    assert(chroma / (px.length / (4 * 97)) < 3, `bw effect left color (${chroma})`);

    // Transition: the cut frame must differ from the same frame without the transition.
    s().select(left.id);
    assert(s().applyTransition("fade"), "transition applied to selected cut");
    assert(findSegment(s().project, left.id)!.segment.transition?.type === "fade", "transition stored on outgoing clip");
    const withTransition = new Uint8ClampedArray(await sample(1.5 * SECOND));
    s().setTransition(left.id, null);
    const hardCut = await sample(1.5 * SECOND);
    let diff = 0;
    for (let i = 0; i < hardCut.length; i += 4 * 97) diff += Math.abs(hardCut[i] - withTransition[i]);
    assert(diff / (hardCut.length / (4 * 97)) > 5, `transition had no visible effect (${diff})`);
    s().undo(); // restore the dissolve for the export

    // Every transition and effect type renders without throwing.
    for (const type of TRANSITIONS) {
      s().setTransition(left.id, { type, duration: SECOND / 2 });
      await sample(1.4 * SECOND);
    }
    for (const kind of TRANSITION_SHAPES) {
      for (const direction of ["grow", "shrink"] as const) {
        s().setTransition(left.id, { type: "shape", duration: SECOND / 2, shape: { kind, text: "CENA", direction, softness: 0.05, rotate: true } });
        await sample(1.45 * SECOND);
      }
    }
    s().setTransition(left.id, { type: "fade", duration: SECOND / 2 });
    for (const type of EFFECTS) s().addEffect(left.id, type);
    await sample(1 * SECOND);
    for (const e of findSegment(s().project, left.id)!.segment.effects) s().removeEffect(left.id, e.id);
    pool.destroy();
    checks.effectsAndTransitions = { bwChroma: Math.round(chroma), transitionDiff: Math.round(diff), transitionTypes: TRANSITIONS.length, effectTypes: EFFECTS.length };

    const drafts = await window.api.listCapcutDrafts();
    const biggest = [...drafts.drafts].sort((a, b) => b.size - a.size)[0];
    if (biggest) {
      const { data } = await window.api.readCapcutDraft(biggest.dir);
      const converted = convertCapcutDraft(data, biggest.dir, biggest.name);
      checks.capcutImport = {
        draft: biggest.name,
        tracks: converted.project.tracks.map((t) => `${t.kind}:${t.segments.length}`),
        materials: Object.keys(converted.project.materials).length,
        durationSeconds: projectDuration(converted.project) / SECOND,
        warnings: converted.warnings,
      };
    } else checks.capcutImport = "no drafts found";

    checks.rendering = await renderingChecks(left.id, right.id);

    // Captions: sentences are split into short lines that keep their order and stay inside the segment.
    const lines = splitCaptions([{ start: 1, end: 5, text: "Olá, este é um teste das legendas automáticas do editor Cena." }], 4);
    assert(lines.length >= 3 && lines[0].start === 1 && lines[lines.length - 1].end <= 5, `caption split ${JSON.stringify(lines)}`);
    checks.captionSplit = lines.map((l) => l.text);

    // Built-in sound effects are synthesized locally and import as audio.
    const builtins = await window.api.libraryBuiltins();
    assert(builtins.length >= 8, "built-in sounds");
    const ding = await window.api.probe(builtins.find((b) => b.id === "ding")!.path);
    assert(ding.kind === "audio" && ding.duration > 0.5 * SECOND, "built-in sound probes as audio");
    checks.builtinSounds = builtins.length;

    let lastProgress = 0;
    const { path, frames } = await exportProject(s().project, {
      outPath: media.output,
      quality: "small",
      onProgress: (done) => (lastProgress = done),
    });
    assert(frames === lastProgress, "progress reached all frames");
    checks.export = { frames, expectedSeconds: projectDuration(s().project) / SECOND };

    checks.timelineEditing = timelineChecks(left.id, right.id, video.id);
    checks.toolbar = await toolbarChecks(left.id, right.id);
    checks.subtitles = subtitleChecks();
    checks.fonts = await fontChecks();
    if (media.ai) checks.ai = await aiChecks(media.video, media.image, media.ai.speech);
    checks.agent = await agentChecks(media);
    checks.gaming = await gamingChecks(media);
    checks.organize = await organizeChecks(media);
    checks.decode = await decodeChecks(media.decodeSamples);
    checks.pieces = await piecesChecks(media.decodeSamples, media.output);
    await window.api.smokeDone({ ok: true, output: path, frames, checks });
  } catch (err) {
    await window.api.smokeDone({ ok: false, error: (err as Error).stack ?? String(err), checks });
  }
}

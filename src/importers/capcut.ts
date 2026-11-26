import type { Material, Project, Segment, TextStyle, Track, TrackKind } from "../model/types";
import { DEFAULT_TEXT, createProject, createSegment, createTrack, sortSegments, uid } from "../model/project";
import { SECOND } from "../model/time";

/**
 * Converts a CapCut desktop draft (draft_content.json) into a Cena project.
 *
 * Mapping (observed in drafts written by CapCut 9.x, schema version 360000):
 * - times are microseconds; segments point at materials by id;
 * - clip.transform x/y are in half-canvas units with y pointing up (Cena's y points down);
 * - clip.scale is relative to the fitted size, like Cena's scale;
 * - texts store rich text as a JSON string in `content` ({text, styles[]}).
 * Transitions keep their timing as a dissolve; effects, filters, stickers and animations are not converted.
 */

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);

export interface CapcutImportResult {
  project: Project;
  warnings: string[];
}

function resolvePath(raw: string, draftDir: string) {
  // CapCut writes "##_draftpath_placeholder_<uuid>_##" for files stored inside the draft folder.
  return raw.replace(/##_draftpath_placeholder_[^#]+_##/g, draftDir).replace(/\//g, "\\");
}

const rgbToHex = (rgb: unknown) => {
  const c = Array.isArray(rgb) ? rgb : [1, 1, 1];
  return `#${c.slice(0, 3).map((v) => Math.round(Math.max(0, Math.min(1, Number(v))) * 255).toString(16).padStart(2, "0")).join("")}`;
};

function parseText(material: Json): TextStyle {
  const style: TextStyle = { ...DEFAULT_TEXT, bold: false, strokeWidth: 0 };
  let content = str(material.content);
  try {
    const rich = JSON.parse(content) as Json;
    content = str(rich.text, content);
    const first = obj(arr(rich.styles)[0]);
    const fill = obj(obj(obj(first.fill).content).solid);
    if (fill.color) style.color = rgbToHex(fill.color);
    // CapCut's default size 15 renders at roughly 90px on a 1080p canvas.
    if (typeof first.size === "number") style.fontSize = Math.round(first.size * 6);
    if (first.bold === true) style.bold = true;
    if (first.italic === true) style.italic = true;
    const stroke = obj(arr(first.strokes)[0]);
    const strokeColor = obj(obj(stroke.content).solid).color;
    if (strokeColor) {
      style.strokeColor = rgbToHex(strokeColor);
      style.strokeWidth = Math.round(num(stroke.width, 0.08) * 60);
    }
  } catch {
    // Older drafts store plain text.
  }
  style.content = content || "Texto";
  if (typeof material.text_color === "string" && material.text_color.startsWith("#")) style.color = material.text_color;
  const align = num(material.alignment, 1);
  style.align = align === 0 ? "left" : align === 2 ? "right" : "center";
  if (material.background_alpha && num(material.background_alpha) > 0 && str(material.background_color)) style.background = str(material.background_color);
  return style;
}

export function convertCapcutDraft(raw: unknown, draftDir: string, name: string): CapcutImportResult {
  const draft = obj(raw);
  const warnings: string[] = [];
  const project = createProject(name);
  project.tracks = [];
  const canvas = obj(draft.canvas_config);
  project.width = num(canvas.width, 1920);
  project.height = num(canvas.height, 1080);
  project.fps = Math.round(num(draft.fps, 30));

  const mats = obj(draft.materials);
  const byId = new Map<string, { kind: "video" | "audio" | "text"; data: Json }>();
  for (const v of arr(mats.videos)) byId.set(str(v.id), { kind: "video", data: v });
  for (const a of arr(mats.audios)) byId.set(str(a.id), { kind: "audio", data: a });
  for (const t of arr(mats.texts)) byId.set(str(t.id), { kind: "text", data: t });
  const speeds = new Map(arr(mats.speeds).map((s) => [str(s.id), num(s.speed, 1)]));
  const transitions = new Map(arr(mats.transitions).map((t) => [str(t.id), num(t.duration, 0)]));
  let transitionsConverted = 0;

  const materialFor = new Map<string, Material>();
  const ensureMaterial = (capId: string, kind: "video" | "audio", data: Json): Material | null => {
    const existing = materialFor.get(capId);
    if (existing) return existing;
    const path = resolvePath(str(data.path), draftDir);
    if (!path) return null;
    const isPhoto = str(data.type) === "photo";
    const material: Material = {
      id: uid("mat"),
      kind: kind === "audio" ? "audio" : isPhoto ? "image" : "video",
      name: str(data.material_name) || str(data.name) || path.split("\\").pop() || "mídia",
      path,
      duration: isPhoto ? 5 * SECOND : num(data.duration, 0),
      width: kind === "video" ? num(data.width) || undefined : undefined,
      height: kind === "video" ? num(data.height) || undefined : undefined,
      hasVideo: kind === "video" && !isPhoto,
      hasAudio: kind === "audio" || (kind === "video" && !isPhoto && data.has_audio !== false),
    };
    materialFor.set(capId, material);
    project.materials[material.id] = material;
    return material;
  };

  const skipped = new Map<string, number>();
  // CapCut lists the main track first and draws later tracks on top; Cena draws index 0 on top.
  const capTracks = arr(draft.tracks);
  const converted: Track[] = [];
  for (const capTrack of capTracks) {
    const type = str(capTrack.type);
    if (type !== "video" && type !== "audio" && type !== "text") {
      skipped.set(type || "desconhecida", (skipped.get(type) ?? 0) + arr(capTrack.segments).length);
      continue;
    }
    const track = createTrack(type as TrackKind);
    for (const capSeg of arr(capTrack.segments)) {
      const target = obj(capSeg.target_timerange);
      const source = obj(capSeg.source_timerange);
      const ref = byId.get(str(capSeg.material_id));
      if (!ref) {
        skipped.set(`${type} sem material`, (skipped.get(`${type} sem material`) ?? 0) + 1);
        continue;
      }
      const clip = obj(capSeg.clip);
      const transform = obj(clip.transform);
      const scale = obj(clip.scale);
      const speedRef = arr(capSeg.extra_material_refs).map((r) => speeds.get(String(r))).find((v) => v !== undefined);
      const segment: Segment = createSegment({
        start: num(target.start),
        duration: Math.max(1, num(target.duration)),
        sourceStart: num(source.start),
        speed: num(capSeg.speed, speedRef ?? 1) || 1,
        volume: num(capSeg.volume, 1),
        transform: {
          x: num(transform.x),
          y: -num(transform.y),
          scale: num(scale.x, 1),
          rotation: num(clip.rotation),
          opacity: num(clip.alpha, 1),
        },
      });
      if (capSeg.visible === false) segment.transform.opacity = 0;
      // CapCut's transition styles are proprietary effects; keep the timing as a dissolve.
      const transitionDuration = arr(capSeg.extra_material_refs).map((r) => transitions.get(String(r))).find((v) => v !== undefined);
      if (transitionDuration && type === "video") {
        segment.transition = { type: "fade", duration: transitionDuration };
        transitionsConverted++;
      }
      if (ref.kind === "text") {
        segment.text = parseText(ref.data);
      } else {
        const material = ensureMaterial(str(capSeg.material_id), ref.kind, ref.data);
        if (!material) continue;
        segment.materialId = material.id;
        if (material.kind === "image") material.duration = Math.max(material.duration, segment.duration);
      }
      track.segments.push(segment);
    }
    if (track.segments.length) {
      sortSegments(track);
      converted.push(track);
    }
  }
  // Reverse visual tracks so the CapCut main track ends up at the bottom; audio stays below.
  const visual = converted.filter((t) => t.kind !== "audio").reverse();
  const audio = converted.filter((t) => t.kind === "audio");
  project.tracks = [...visual, ...audio];
  if (!project.tracks.some((t) => t.kind === "video")) project.tracks.unshift(createTrack("video", "Principal"));

  for (const [kind, count] of skipped) warnings.push(`${count} item(ns) de faixa "${kind}" não foram convertidos.`);
  if (transitionsConverted) warnings.push(`${transitionsConverted} transição(ões) convertida(s) como "Dissolver" com a mesma duração.`);
  const unsupported = ["effects", "video_effects", "material_animations", "stickers", "filters"]
    .map((k) => [k, arr(mats[k]).length] as const)
    .filter(([, n]) => n > 0);
  if (unsupported.length) warnings.push(`Ignorados (ainda sem suporte): ${unsupported.map(([k, n]) => `${k} (${n})`).join(", ")}.`);
  return { project, warnings };
}

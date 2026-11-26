import { create } from "zustand";
import { multiSelection, useEditor } from "./store";

export type GuideKind = "none" | "thirds" | "grid" | "center" | "tiktok" | "reels" | "shorts";

/** View-only state that is neither part of the project nor of undo history. */
interface UiState {
  /** Segment whose freeform mask is being drawn by clicking on the preview. */
  maskDrawing: string | null;
  guides: GuideKind;
  /** Moving or deleting clips closes/opens gaps on the same track. */
  ripple: boolean;
  /** Extra selected clips besides the editor's main selection (Ctrl/Shift+click). */
  multi: string[];
  /** Timeline pointer: select/move, or blade (click splits). */
  tool: "select" | "blade";
  /** Main track magnet: the bottom video track never keeps gaps. */
  magnet: boolean;
  /** Clips snap to edges, markers and the playhead while dragging. */
  snap: boolean;
  /** A video and its detached audio move and get deleted together. */
  link: boolean;
  /** Preview axis: hovering the timeline previews that instant. */
  previewAxis: boolean;
  /** Time under the pointer while the preview axis is on (null when not hovering). */
  skim: number | null;
  /** Silences playback (used while recording a voiceover). */
  muteProject: boolean;
  /** Voiceover recording: counting down, recording or saving (the toolbar mic button stops it). */
  voiceover: "off" | "countdown" | "recording" | "saving";
  /** How fast the preview plays. Only for watching: exports are not affected. */
  playRate: number;
  /** The preview is playing backwards; falls back to forwards when it stops. */
  playReverse: boolean;
  /** The clip menu asked for the export window, set to export only the selection. */
  exportSelection: boolean;
  set(patch: Partial<Omit<UiState, "set">>): void;
}

function saved(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(`cena.ui.${key}`);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

export const useUi = create<UiState>((set) => ({
  maskDrawing: null,
  guides: "none",
  ripple: false,
  multi: [],
  tool: "select",
  magnet: saved("magnet", true),
  snap: saved("snap", true),
  link: saved("link", true),
  previewAxis: false,
  skim: null,
  muteProject: false,
  voiceover: "off",
  playRate: 1,
  playReverse: false,
  exportSelection: false,
  set: (patch) => set(patch),
}));

multiSelection.set = (ids) => useUi.setState({ multi: ids });
useUi.subscribe((s, before) => {
  for (const key of ["magnet", "snap", "link"] as const) {
    if (s[key] === before[key]) continue;
    try {
      localStorage.setItem(`cena.ui.${key}`, s[key] ? "1" : "0");
    } catch {
      // Not kept: the default comes back next time.
    }
  }
});

/** `ids` plus every clip grouped with them (groups always act as one). */
export function withGroups(ids: string[]): string[] {
  const all = useEditor.getState().project.tracks.flatMap((t) => t.segments);
  const groups = new Set(all.filter((s) => ids.includes(s.id) && s.groupId).map((s) => s.groupId));
  if (!groups.size) return ids;
  return [...new Set([...ids, ...all.filter((s) => s.groupId && groups.has(s.groupId)).map((s) => s.id)])];
}

/** `ids` plus their groups and, when linking is on, the clips linked to them. */
export function withLinked(ids: string[]): string[] {
  const grouped = withGroups(ids);
  if (!useUi.getState().link) return grouped;
  const all = useEditor.getState().project.tracks.flatMap((t) => t.segments);
  const links = new Set(all.filter((s) => grouped.includes(s.id) && s.linkId).map((s) => s.linkId));
  return withGroups([...new Set([...grouped, ...all.filter((s) => s.linkId && links.has(s.linkId)).map((s) => s.id)])]);
}

/**
 * What a delete takes: the selection with its groups, and the audio linked to a video in it. Deleting an audio clip
 * on its own leaves its video alone.
 */
export function withLinkedForDelete(ids: string[]): string[] {
  const grouped = withGroups(ids);
  if (!useUi.getState().link) return grouped;
  const tracks = useEditor.getState().project.tracks;
  const all = tracks.flatMap((t) => t.segments.map((s) => ({ s, kind: t.kind })));
  const links = new Set(all.filter((x) => grouped.includes(x.s.id) && x.s.linkId && x.kind !== "audio").map((x) => x.s.linkId));
  return withGroups([...new Set([...grouped, ...all.filter((x) => x.s.linkId && links.has(x.s.linkId)).map((x) => x.s.id)])]);
}

/** Run after edits that can leave gaps: with the magnet on, the main track closes them. */
export function afterEdit(anchor?: string[]) {
  if (!useUi.getState().magnet) return;
  // Gaps that were there before this edit (left on purpose) stay; only the ones it opened close.
  const { past } = useEditor.getState();
  useEditor.getState().compactMainTrack({ before: past[past.length - 1], anchor });
}

/** All selected clips: the editor's main selection first, then the extra ones that still exist. */
export function selectedIds(): string[] {
  const { selectedId, project } = useEditor.getState();
  if (!selectedId) return [];
  const exists = new Set(project.tracks.flatMap((t) => t.segments.map((s) => s.id)));
  return [selectedId, ...useUi.getState().multi.filter((id) => id !== selectedId && exists.has(id))];
}

// Clearing the main selection (Esc, clicking empty space, deleting) also clears the extra one.
useEditor.subscribe((state, prev) => {
  if (state.selectedId === null && prev.selectedId !== null && useUi.getState().multi.length) useUi.setState({ multi: [] });
});

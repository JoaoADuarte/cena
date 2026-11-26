import type { Micros, Project } from "../model/types";
import { nextAdjacent, segmentEnd } from "../model/project";

/**
 * A separate copy of the project holding only the given clips, for exporting just that part.
 * Clips that play at the same time stay together; the empty time between them is closed.
 * The project being edited is not touched.
 */
export function projectFromSelection(project: Project, ids: string[]): Project | null {
  const chosen = new Set(ids);
  const picked = project.tracks.flatMap((t) => t.segments.filter((s) => chosen.has(s.id)));
  if (!picked.length) return null;

  const spans: { from: Micros; to: Micros }[] = [];
  for (const s of [...picked].sort((a, b) => a.start - b.start)) {
    const last = spans.at(-1);
    if (last && s.start <= last.to) last.to = Math.max(last.to, segmentEnd(s));
    else spans.push({ from: s.start, to: segmentEnd(s) });
  }
  let kept: Micros = 0;
  const shifted = spans.map((span) => {
    const at = { ...span, shift: span.from - kept };
    kept += span.to - span.from;
    return at;
  });
  const shiftOf = (start: Micros) => shifted.findLast((span) => start >= span.from)!.shift;

  const copy = structuredClone(project);
  copy.markers = [];
  for (const track of copy.tracks) {
    // Read before filtering: a transition only survives if the clip it leads into was exported too.
    const fading = new Set(track.segments.filter((s, i) => s.transition && !chosen.has(nextAdjacent(track, i)?.id ?? "")).map((s) => s.id));
    track.segments = track.segments.filter((s) => chosen.has(s.id));
    for (const s of track.segments) {
      if (fading.has(s.id)) s.transition = null;
      s.start -= shiftOf(s.start);
    }
  }
  return copy;
}

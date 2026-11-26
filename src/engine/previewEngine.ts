import { useEditor } from "../store";
import { useUi } from "../ui";
import { MAX_VOLUME, type Material, type Micros, type Project, type Segment, type Track } from "../model/types";
import { gainAt, isActiveAt, projectDuration, segmentEnd, visibleRange } from "../model/project";
import { SECOND } from "../model/time";
import { drawFrame, framesNeeded, sourceSecondsAt } from "./compositor";
import { MediaPool } from "./mediaPool";

const PRELOAD: Micros = 2 * SECOND;
const DRIFT_TOLERANCE = 0.2; // seconds before a playing element is re-synced
/** While a clip's picture is being decoded the last frame stays on screen, up to this long, instead of black. */
const HOLD_MS = 1500;

/**
 * Drives real-time preview: owns a playback clock, keeps media elements in sync with the
 * timeline and redraws the canvas every animation frame.
 */
export class PreviewEngine {
  private pool = new MediaPool(false);
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private clockStart = 0;
  private clockOrigin: Micros = 0;
  private wasPlaying = false;
  /** Timeline seconds per real second of the running clock. */
  private velocity = 1;
  private rate = 1;
  private lastProject: Project | null = null;
  /** When the canvas last showed every visible clip; 0 while nothing has been drawn. */
  private lastFull = 0;
  /** How long seeks take per element (seconds), to aim ahead of the clock when re-syncing during playback. */
  private seekCost = new WeakMap<HTMLMediaElement, number>();
  private seekStarted = new WeakMap<HTMLMediaElement, number>();

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas 2D indisponível");
    this.ctx = ctx;
    this.raf = requestAnimationFrame(this.tick);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.pool.destroy();
    void this.audio?.close();
  }

  /** Created on first need: media elements stop at 100% volume, a gain node goes up to MAX_VOLUME. */
  private audio: AudioContext | null = null;
  private boosted = new WeakMap<HTMLMediaElement, GainNode>();

  private applyGain(el: HTMLMediaElement, gain: number) {
    let node = this.boosted.get(el);
    if (!node && gain <= 1) {
      el.volume = Math.max(0, gain);
      return;
    }
    if (!node) {
      // Once routed through Web Audio an element stays there; its own volume then stays at 1.
      this.audio ??= new AudioContext();
      node = this.audio.createGain();
      this.audio.createMediaElementSource(el).connect(node).connect(this.audio.destination);
      this.boosted.set(el, node);
    }
    if (this.audio?.state === "suspended") void this.audio.resume();
    el.volume = 1;
    node.gain.value = Math.max(0, Math.min(MAX_VOLUME, gain));
  }

  private tick = () => {
    this.raf = requestAnimationFrame(this.tick);
    const state = useEditor.getState();
    const { project, playing } = state;
    let t = state.playhead;
    const ui = useUi.getState();
    // A voiceover is recorded against the picture in real time.
    this.rate = ui.muteProject ? 1 : ui.playRate;
    const reverse = ui.playReverse && !ui.muteProject;
    const velocity = reverse ? -this.rate : this.rate;

    if (playing && !this.wasPlaying) {
      const end = projectDuration(project);
      // At the far end, start over from the other one.
      if (reverse ? t <= 0 : t >= end - SECOND / project.fps) t = reverse ? end : 0;
      this.clockStart = performance.now();
      this.clockOrigin = t;
      this.velocity = velocity;
    } else if (playing && velocity !== this.velocity) {
      // Speed or direction changed mid-play: carry on from here.
      this.clockStart = performance.now();
      this.clockOrigin = t;
      this.velocity = velocity;
    }
    if (playing) {
      t = this.clockOrigin + (performance.now() - this.clockStart) * 1000 * velocity;
      const end = projectDuration(project);
      if (velocity > 0 && t >= end) {
        t = end;
        state.setPlaying(false);
      } else if (velocity < 0 && t <= 0) {
        t = 0;
        state.setPlaying(false);
        ui.set({ playReverse: false });
      }
      state.setPlayhead(t);
    }
    if (!playing && this.wasPlaying) {
      this.pool.pauseAll();
      if (ui.playReverse) ui.set({ playReverse: false });
    }
    this.wasPlaying = playing && useEditor.getState().playing;
    // Preview axis: while paused, hovering the timeline shows that instant without moving the playhead.
    const skim = useUi.getState().skim;
    if (!playing && skim !== null) t = skim;

    if (project !== this.lastProject) {
      this.lastProject = project;
      this.resize(project);
      const segIds = new Set<string>();
      for (const tr of project.tracks) for (const s of tr.segments) segIds.add(s.id);
      this.pool.retain(segIds, new Set(Object.keys(project.materials)));
    }

    this.syncMedia(project, t, this.wasPlaying && !reverse, this.wasPlaying && reverse);
    // A clip whose frame is still being decoded (just after a cut or a seek) would come out black:
    // keep the last picture a moment instead, as long as nothing in the project changed meanwhile.
    const now = performance.now();
    const waiting = this.waitingForPicture(project, t);
    if (waiting && this.lastFull && now - this.lastFull < HOLD_MS && project === this.drawnProject) return;
    drawFrame(this.ctx, project, t, this.pool);
    this.drawnProject = project;
    if (!waiting) this.lastFull = now;
  };

  private drawnProject: Project | null = null;

  /** True when a video clip on screen at `t` has no decoded frame yet. */
  private waitingForPicture(project: Project, t: Micros) {
    for (const track of project.tracks) {
      if (track.kind !== "video" || track.hidden) continue;
      for (const s of framesNeeded(track, t)) {
        const material = s.materialId ? project.materials[s.materialId] : undefined;
        if (!material || material.kind === "image" || !material.hasVideo || this.pool.decoded(s.id)) continue;
        const el = this.pool.video(s, material);
        if (el.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !el.videoWidth) return true;
      }
    }
    return false;
  }

  /** Seek, remembering how long it takes. */
  private seek(el: HTMLMediaElement, seconds: number) {
    if (!this.seekStarted.has(el)) {
      el.addEventListener("seeked", () => {
        const started = this.seekStarted.get(el);
        if (!started) return;
        const took = (performance.now() - started) / 1000;
        const before = this.seekCost.get(el) ?? took;
        this.seekCost.set(el, Math.min(1.5, before * 0.5 + took * 0.5));
        this.seekStarted.set(el, 0);
      });
    }
    this.seekStarted.set(el, performance.now());
    el.currentTime = seconds;
  }

  private resize(project: Project) {
    if (this.canvas.width !== project.width || this.canvas.height !== project.height) {
      this.canvas.width = project.width;
      this.canvas.height = project.height;
    }
  }

  private syncMedia(project: Project, t: Micros, playing: boolean, reversing: boolean) {
    for (const track of project.tracks) {
      track.segments.forEach((s, index) => {
        const material = s.materialId ? project.materials[s.materialId] : undefined;
        if (!material || material.kind === "image" || material.pending) return;
        // Transitions extend a clip past its cut, so sync over its whole visible range.
        const [from, to] = track.kind === "video" ? visibleRange(track, index) : [s.start, segmentEnd(s)];
        // Going backwards the clip that comes next is the one before, so it gets ready on the other side.
        if (t < from - PRELOAD || t >= to + (reversing ? PRELOAD : 0)) {
          // Out of range nothing syncs it any more: left alone it plays on, over whatever comes next.
          this.pool.pause(s.id);
          return;
        }
        const el = track.kind === "audio" || !material.hasVideo ? this.pool.audio(s, material) : this.pool.video(s, material);
        // The picture runs through a transition on both sides of the cut, like the export: the clip going out keeps
        // playing past its end and the one coming in starts before its start. A clip that comes next waits on the
        // frame it will show first (its last one going backwards), so reaching it only takes pressing play.
        const shown = Math.min(Math.max(t, from), to - 1);
        this.syncElement(el, track, s, material, shown, t, playing, reversing, t >= from);
      });
    }
  }

  private syncElement(el: HTMLMediaElement, track: Track, s: Segment, material: Material, shown: Micros, t: Micros, playing: boolean, reversing: boolean, active: boolean) {
    if (el.readyState < HTMLMediaElement.HAVE_METADATA) return;
    const expected = sourceSecondsAt(s, shown, material);
    // Audio stays a hard cut at the clip edges even while the picture overlaps.
    const gain = isActiveAt(s, t) ? gainAt(s, t - s.start) : 0;
    this.applyGain(el, gain);
    // The project is muted while a voiceover records, so the speakers don't leak into the microphone.
    el.muted = track.muted || gain === 0 || useUi.getState().muteProject || reversing;
    const rate = Math.max(0.0625, Math.min(16, s.speed * this.rate));
    if (Math.abs(el.playbackRate - rate) > 1e-3) el.playbackRate = rate;
    // Watching faster or slower should not change the pitch of the voices.
    const keepPitch = s.keepPitch || this.rate !== 1;
    if (el.preservesPitch !== keepPitch) el.preservesPitch = keepPitch;
    // Sound cannot play backwards, so there is no point in seeking it.
    if (reversing && !(el instanceof HTMLVideoElement)) {
      if (!el.paused) el.pause();
      return;
    }

    if (playing && active) {
      const off = Math.abs(el.currentTime - expected);
      // Aim where the clock will be once the seek is done; seeking to "now" lands late and starts another seek.
      const ahead = (this.seekCost.get(el) ?? 0.1) * rate;
      if (el.paused) {
        // Already waiting at the right frame (it was prepared before the cut): just play, no new seek.
        if (off > DRIFT_TOLERANCE * Math.max(1, rate)) this.seek(el, expected + ahead);
        void el.play().catch(() => undefined);
      } else if (!el.seeking && off > DRIFT_TOLERANCE * Math.max(1, rate)) {
        this.seek(el, expected + ahead);
      }
      return;
    }
    if (!el.paused) el.pause();
    // Scrubbing/paused: show the exact frame (half a frame of tolerance avoids seek storms).
    if (!el.seeking && Math.abs(el.currentTime - expected) > 0.5 / 30) this.seek(el, expected);
  }
}

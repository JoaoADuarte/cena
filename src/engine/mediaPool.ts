import type { Material, Segment } from "../model/types";

export const mediaUrl = (path: string) => `media://file/${encodeURIComponent(path)}`;

/**
 * Owns the HTML media elements used to decode clips. Video and audio get one element per
 * segment (the same file can play at two times at once); images are shared per material.
 */
export class MediaPool {
  private videos = new Map<string, HTMLVideoElement>();
  private audios = new Map<string, HTMLAudioElement>();
  private images = new Map<string, HTMLImageElement>();
  private frames = new Map<string, { source: CanvasImageSource; width: number; height: number }>();
  private readonly silent: boolean;

  constructor(silent: boolean) {
    this.silent = silent;
  }

  video(segment: Segment, material: Material): HTMLVideoElement {
    let el = this.videos.get(segment.id);
    const src = mediaUrl(material.path);
    if (!el || el.dataset.src !== src) {
      el?.removeAttribute("src");
      el = document.createElement("video");
      el.crossOrigin = "anonymous";
      el.preload = "auto";
      el.playsInline = true;
      el.muted = this.silent;
      el.dataset.src = src;
      el.src = src;
      this.videos.set(segment.id, el);
    }
    return el;
  }

  /** Stop a clip's elements, if it has any (it left the playback range). */
  pause(segmentId: string) {
    const video = this.videos.get(segmentId);
    if (video && !video.paused) video.pause();
    const audio = this.audios.get(segmentId);
    if (audio && !audio.paused) audio.pause();
  }

  /** A frame decoded elsewhere, drawn instead of the clip's video element; null goes back to the element. */
  setDecoded(segmentId: string, frame: { source: CanvasImageSource; width: number; height: number } | null) {
    if (frame) this.frames.set(segmentId, frame);
    else this.frames.delete(segmentId);
  }

  decoded(segmentId: string) {
    return this.frames.get(segmentId);
  }

  audio(segment: Segment, material: Material): HTMLAudioElement {
    let el = this.audios.get(segment.id);
    const src = mediaUrl(material.path);
    if (!el || el.dataset.src !== src) {
      el?.removeAttribute("src");
      el = new Audio();
      el.crossOrigin = "anonymous";
      el.preload = "auto";
      el.muted = this.silent;
      el.dataset.src = src;
      el.src = src;
      this.audios.set(segment.id, el);
    }
    return el;
  }

  image(material: Material): HTMLImageElement {
    let el = this.images.get(material.id);
    if (!el) {
      el = new Image();
      el.crossOrigin = "anonymous";
      el.src = mediaUrl(material.path);
      this.images.set(material.id, el);
    }
    return el;
  }

  /** Release elements for segments/materials that no longer exist. */
  retain(segmentIds: Set<string>, materialIds: Set<string>) {
    for (const [id, el] of this.videos) if (!segmentIds.has(id)) this.dispose(this.videos, id, el);
    for (const [id, el] of this.audios) if (!segmentIds.has(id)) this.dispose(this.audios, id, el);
    for (const id of this.images.keys()) if (!materialIds.has(id)) this.images.delete(id);
  }

  pauseAll() {
    for (const el of this.videos.values()) el.pause();
    for (const el of this.audios.values()) el.pause();
  }

  destroy() {
    for (const [id, el] of this.videos) this.dispose(this.videos, id, el);
    for (const [id, el] of this.audios) this.dispose(this.audios, id, el);
    this.images.clear();
  }

  private dispose(map: Map<string, HTMLMediaElement>, id: string, el: HTMLMediaElement) {
    el.pause();
    el.removeAttribute("src");
    el.load();
    map.delete(id);
  }
}

function waitFor(el: HTMLMediaElement, event: string, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for ${event}`));
    }, timeoutMs);
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(el.error?.message || "media error"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      el.removeEventListener(event, onEvent);
      el.removeEventListener("error", onError);
    };
    el.addEventListener(event, onEvent);
    el.addEventListener("error", onError);
  });
}

/** Seek precisely and resolve once the frame at `seconds` is decoded. */
export async function seekExact(el: HTMLVideoElement, seconds: number, timeoutMs = 15000) {
  if (el.readyState < HTMLMediaElement.HAVE_METADATA) await waitFor(el, "loadedmetadata", timeoutMs);
  const target = Math.min(Math.max(0, seconds), Math.max(0, el.duration - 0.001));
  if (Math.abs(el.currentTime - target) < 0.0005 && el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
  const seeked = waitFor(el, "seeked", timeoutMs);
  el.currentTime = target;
  await seeked;
}

export async function imageReady(img: HTMLImageElement) {
  if (img.complete && img.naturalWidth > 0) return;
  await img.decode();
}

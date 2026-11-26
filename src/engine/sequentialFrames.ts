import type { Material, Segment } from "../model/types";
import type { MediaPool } from "./mediaPool";

interface Reader {
  /** Null: this clip goes through the browser (seek per frame). */
  id: string | null;
  canvas: HTMLCanvasElement;
}

let nextCanvas = 1;

/**
 * A canvas the preload can reach: it reads and writes pixels directly, since handing it a frame costs
 * more than decoding one. In the document, but never shown.
 */
export function sharedCanvas(width: number, height: number, attributes?: CanvasRenderingContext2DSettings): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.id = `cena-frame-${nextCanvas++}`;
  canvas.width = width;
  canvas.height = height;
  canvas.style.display = "none";
  // The preload asks for this context with the same settings; the first request decides them.
  canvas.getContext("2d", { willReadFrequently: true, ...attributes });
  document.body.appendChild(canvas);
  return canvas;
}

/**
 * Export's video source: frames decoded in order by FFmpeg, one reader per clip on screen.
 * They are handed to the compositor through the pool, in place of the clip's <video> element.
 */
export class SequentialFrames {
  private readers = new Map<string, Reader>();

  constructor(private readonly pool: MediaPool) {}

  /** Load the clip's frame for `seconds`; false means the caller has to seek instead. */
  async prepare(segment: Segment, material: Material, seconds: number): Promise<boolean> {
    let reader = this.readers.get(segment.id);
    if (!reader) {
      const id = await window.api.decodeOpen(material.path, seconds).catch(() => null);
      reader = { id, canvas: sharedCanvas(1, 1) };
      this.readers.set(segment.id, reader);
    }
    if (reader.id === null) return false;
    const frame = await window.api.decodeFrameTo(reader.id, seconds, reader.canvas.id).catch(() => null);
    if (!frame) {
      void window.api.decodeClose(reader.id);
      reader.id = null;
      this.pool.setDecoded(segment.id, null);
      return false;
    }
    this.pool.setDecoded(segment.id, { source: reader.canvas, width: frame.width, height: frame.height });
    return true;
  }

  /** Stop the readers of clips no longer on screen. */
  retain(active: Set<string>) {
    for (const [segmentId, reader] of this.readers) {
      if (active.has(segmentId)) continue;
      if (reader.id !== null) void window.api.decodeClose(reader.id);
      reader.canvas.remove();
      this.pool.setDecoded(segmentId, null);
      this.readers.delete(segmentId);
    }
  }

  destroy() {
    this.retain(new Set());
  }
}

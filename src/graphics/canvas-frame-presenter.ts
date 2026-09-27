import type {Rect} from './surface.js';
import {beginRuntimeSpan, recordRuntimeMetric} from '../platform/runtime-performance.js';

const canvasVersions = new WeakMap<HTMLCanvasElement, object>();

/** Other drawing paths call this when they modify a canvas owned by a frame presenter. */
export function invalidateCanvasFrame(canvas: HTMLCanvasElement): object {
  const version = {};
  canvasVersions.set(canvas, version);
  return version;
}

/** Avoid uploading an unchanged mutable ImageData; callers advance revision when its bytes change. */
export class CanvasFramePresenter {
  private frame: ImageData | null = null;
  private revision: object | null = null;
  private canvasVersion: object | undefined;
  private width = 0;
  private height = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly context: CanvasRenderingContext2D,
  ) {}

  /** Damage covers all writes since this presenter last consumed the frame. Omit for a full upload. */
  present(frame: ImageData, revision: object, damage?: Rect): void {
    const intact =
      this.frame === frame &&
      this.width === this.canvas.width &&
      this.height === this.canvas.height &&
      this.canvasVersion === canvasVersions.get(this.canvas);
    if (intact && this.revision === revision) return;
    const partial = intact && damage !== undefined;
    const pixels = partial ? damage.width * damage.height : frame.width * frame.height;
    const finishUpload = beginRuntimeSpan('graphics.canvas.upload');
    try {
      if (partial)
        this.context.putImageData(frame, 0, 0, damage.x, damage.y, damage.width, damage.height);
      else this.context.putImageData(frame, 0, 0);
    } finally {
      finishUpload?.({width: frame.width, height: frame.height, pixels, partial});
      recordRuntimeMetric('graphics.canvas.upload.pixels', pixels);
    }
    this.canvasVersion = invalidateCanvasFrame(this.canvas);
    this.frame = frame;
    this.revision = revision;
    this.width = this.canvas.width;
    this.height = this.canvas.height;
  }
}

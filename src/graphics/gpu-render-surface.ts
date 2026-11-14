import type {TriangleImage} from './triangle-draw.js';

/** Identity and dimensions of a GPU-owned RGBA8 surface. No CPU pixel copy exists.
 * Prepare on the target before use; invalidate there to release its allocation. */
export class GpuRenderSurface implements TriangleImage {
  readonly pixels = new Uint8Array(0);
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
      throw new Error('Invalid GPU surface dimensions');
  }
}

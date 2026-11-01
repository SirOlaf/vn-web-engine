import type {TriangleImage} from './triangle-draw.js';

/** Shared GPU registration at the UI boundary; drawing still uses DrawListTarget. */
export interface SharedGpuImageTarget {
  /** True when the browser presents the shared context's canvas itself, with no copy or
   * readback waiting for recorded GPU commands. */
  readonly presented?: boolean;
  sharedContext(): WebGL2RenderingContext;
  attachSharedImage(
    image: GpuTextureImage,
    context: WebGL2RenderingContext,
    texture: WebGLTexture,
  ): void;
  invalidate(image: object): void;
}

/** GPU-only image identity. The owner keeps its texture alive until the target detaches it. */
export class GpuTextureImage implements TriangleImage {
  readonly pixels = new Uint8Array(0);
  constructor(
    readonly width: number,
    readonly height: number,
    /** Which logical row occupies texture row0, independently of presentation coordinates. */
    readonly rowOrigin: 'top' | 'bottom' = 'top',
  ) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
      throw new Error('Invalid GPU image dimensions');
  }
}

import type {BurikoBitmapCompositor} from './bitmap-compositor.js';
import {burikoGlyphOutlineWeights} from './font-outline.js';
import type {BurikoBitmap} from './bitmap.js';
import {
  burikoGpuDeferrer,
  burikoGpuTarget,
  type BurikoGpuKernel,
  type BurikoGpuTargetStorage,
} from './bitmap-gpu-target.js';
import {
  decorateRasterText,
  rasterTextArguments,
  recordRasterTextOperation,
  withRasterText,
  type RasterTextBitmap,
  type RasterTextOperationOptions,
} from '../../../text/raster-text.js';

/** The transport is shared web presentation code; native bitmaps remain canonical. */
export {recordRasterText as recordBurikoBitmapText} from '../../../text/raster-text.js';

/**
 * Attach a native text effect to a rasterized source glyph before its effect passes are
 * composited. Mode 1 draws the recolored glyph offset by the radii beneath it; mode 2 draws a
 * weighted edge of those radii around it (`burikoGlyphOutlineWeights`). Both pass `256 - opacity` as the compositor's
 * transparency, so the effect's alpha is `opacity / 256`.
 */
export function decorateBurikoBitmapText(
  glyph: RasterTextBitmap,
  effect: {readonly mode: number; readonly color: number; readonly opacity: number},
  radiusX: number,
  radiusY: number,
): void {
  const mode = effect.mode | 0;
  if (mode !== 1 && mode !== 2) return;
  const color = effect.color & 0xffffff,
    alpha = Math.max(0, Math.min(255, Math.round((effect.opacity * 255) / 256)));
  decorateRasterText(
    glyph,
    mode === 1
      ? {shadows: [{x: radiusX, y: radiusY, color, alpha}]}
      : {
          outline: {
            radiusX,
            radiusY,
            color,
            alpha,
            weights: burikoGlyphOutlineWeights(radiusX, radiusY),
          },
        },
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Kernel = (...args: any[]) => any;

/**
 * Raster-text transport for a native kernel. A destination on a browser-optimized GPU display
 * target is sent to that target instead, under the `gpu` id when the kernel has one. When the
 * target maintains the textless plane, the kernel is replayed there with textless arguments and
 * its text bookkeeping is recorded on the software display storage, as a software frame would.
 * A tagged kernel may instead be deferred, returning zero, when the GPU will produce its result.
 */
export function withBurikoBitmapText<T extends Kernel>(
  kernel: T,
  options: RasterTextOperationOptions<T> & {gpu?: BurikoGpuKernel} = {},
): T {
  const {gpu, ...textOptions} = options;
  const wrapped = withRasterText(kernel, textOptions);
  const destination = textOptions.destination ?? 0;
  return function (this: unknown, ...args: Parameters<T>): ReturnType<T> {
    const target = burikoGpuTarget(args[destination]);
    if (target !== null) {
      // Nested kernels draw into whichever image the outer kernel targets.
      if (gpuDepth !== 0 || !target.textless)
        return target.dispatch(gpu, args, kernel.name) as ReturnType<T>;
      gpuDepth++;
      try {
        const result = target.dispatch(gpu, args, kernel.name) as ReturnType<T>;
        if (textOptions.applied && !textOptions.applied(result, args)) return result;
        const alternate = rasterTextArguments(textOptions, args);
        target.replay(() => void target.dispatch(gpu, alternate, kernel.name));
        const software = [...args] as Parameters<T>;
        const display = args[destination] as BurikoBitmap;
        software[destination] = {
          ...display,
          storage: (display.storage as BurikoGpuTargetStorage).software,
        };
        recordRasterTextOperation(textOptions, software, result);
        return result;
      } finally {
        gpuDepth--;
      }
    }
    if (
      gpu !== undefined &&
      burikoGpuDeferrer()?.defer(gpu, args, (copied) =>
        wrapped.apply(this, copied as Parameters<T>),
      )
    )
      return 0 as ReturnType<T>;
    return wrapped.apply(this, args);
  } as T;
}
let gpuDepth = 0;

/** Presentation replays must not change the native worker pool or its callback state. */
export function burikoBitmapTextCompositor(
  compositor: BurikoBitmapCompositor,
): BurikoBitmapCompositor {
  return Object.assign(Object.create(compositor) as BurikoBitmapCompositor, {processing: null});
}

import type {BurikoBitmapCompositor} from './bitmap-compositor.js';
import {burikoGpuDeferrer, burikoGpuTarget, type BurikoGpuKernel} from './bitmap-gpu-target.js';
import {withRasterText, type RasterTextOperationOptions} from '../../../text/raster-text.js';

/** The transport is shared web presentation code; native bitmaps remain canonical. */
export {recordRasterText as recordBurikoBitmapText} from '../../../text/raster-text.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Kernel = (...args: any[]) => any;

/**
 * Raster-text transport for a native kernel. A destination on a browser-optimized GPU display
 * target is sent to that target instead, under the `gpu` id when the kernel has one. The
 * display's text plane is not maintained for GPU frames, which only run in Native text mode.
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
    if (target !== null) return target.dispatch(gpu, args, kernel.name) as ReturnType<T>;
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

/** Presentation replays must not change the native worker pool or its callback state. */
export function burikoBitmapTextCompositor(
  compositor: BurikoBitmapCompositor,
): BurikoBitmapCompositor {
  return Object.assign(Object.create(compositor) as BurikoBitmapCompositor, {processing: null});
}

import type {BurikoBitmapCompositor} from './bitmap-compositor.js';

/** The transport is shared web presentation code; native bitmaps remain canonical. */
export {
  recordRasterText as recordBurikoBitmapText,
  withRasterText as withBurikoBitmapText,
} from '../../../text/raster-text.js';

/** Presentation replays must not change the native worker pool or its callback state. */
export function burikoBitmapTextCompositor(
  compositor: BurikoBitmapCompositor,
): BurikoBitmapCompositor {
  return Object.assign(Object.create(compositor) as BurikoBitmapCompositor, {processing: null});
}

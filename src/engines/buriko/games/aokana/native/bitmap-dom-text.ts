import type {AokanaBitmapCompositor} from './bitmap-compositor.js';

/** The transport is shared web presentation code; native bitmaps remain canonical. */
export {
  recordRasterText as recordAokanaBitmapText,
  withRasterText as withAokanaBitmapText,
} from '../../../../../text/raster-text.js';

/** Presentation replays must not change the native worker pool or its callback state. */
export function aokanaBitmapTextCompositor(
  compositor: AokanaBitmapCompositor,
): AokanaBitmapCompositor {
  return Object.assign(Object.create(compositor) as AokanaBitmapCompositor, {processing: null});
}

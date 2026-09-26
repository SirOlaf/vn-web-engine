import type {BurikoBitmap} from './bitmap.js';
import type {BurikoBitmapCompositor} from './bitmap-compositor.js';
import {transformBurikoBitmap} from './bitmap-affine.js';

/** 052450/04EB70 centered uniform-scale facade over actual052480 affine copy. */
export function rotateCenteredBurikoBitmap(
  compositor: BurikoBitmapCompositor,
  destination: BurikoBitmap,
  source: BurikoBitmap,
  scale: number,
  angle: number,
): 0 | 1 | 0x13 {
  scale >>>= 0;
  if (scale === 0) return 0x13;
  if (destination.format !== source.format) return 1;
  return transformBurikoBitmap(
    compositor,
    destination,
    source,
    {
      x: destination.width << 15,
      y: destination.height << 15,
      pivotX: source.width << 15,
      pivotY: source.height << 15,
      angle: angle | 0,
      scaleX: scale,
      scaleY: scale,
    },
    0,
    0,
    true,
  );
}

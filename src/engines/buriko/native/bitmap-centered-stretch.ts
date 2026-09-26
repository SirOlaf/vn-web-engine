import type {BurikoBitmap} from './bitmap.js';
import type {BurikoBitmapCompositor} from './bitmap-compositor.js';
import {transformBurikoBitmap} from './bitmap-affine.js';

function cvtt32(value: number): number {
  const integer = Math.trunc(value);
  return !Number.isFinite(integer) || integer < -0x80000000 || integer > 0x7fffffff
    ? -0x80000000
    : integer | 0;
}

/** 0523C0/04EA00 centered window facade over actual052480 affine copy. */
export function stretchCenteredBurikoBitmap(
  compositor: BurikoBitmapCompositor,
  destination: BurikoBitmap,
  source: BurikoBitmap,
  x: number,
  y: number,
  width: number,
  height: number,
  scaleX: number,
  scaleY: number,
): 0 | 1 | 0x13 | 0x14 {
  width >>>= 0;
  height >>>= 0;
  scaleX >>>= 0;
  scaleY >>>= 0;
  if (width <= 0x1ffff || height <= 0x1ffff) return 0x14;
  if (scaleX === 0 || scaleY === 0) return 0x13;
  if (destination.format !== source.format) return 1;
  const correctionX = scaleX < 0x10000 ? cvtt32((32768 / scaleX - 0.5) * 65536) : 0;
  const correctionY = scaleY < 0x10000 ? cvtt32((32768 / scaleY - 0.5) * 65536) : 0;
  return transformBurikoBitmap(
    compositor,
    destination,
    source,
    {
      x: destination.width << 15,
      y: destination.height << 15,
      pivotX: (correctionX + x + (width >>> 1)) | 0,
      pivotY: (correctionY + y + (height >>> 1)) | 0,
      angle: 0,
      scaleX,
      scaleY,
    },
    0,
    1,
    true,
  );
}

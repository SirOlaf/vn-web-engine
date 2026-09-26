import type {AokanaBitmap} from './bitmap.js';
import {bitmapWrite16} from './bitmap-scalar.js';
import type {AokanaCrtRandom} from './system-timing.js';

/** 034880 writes two Q4 displacement WORDs with signed loops and unsigned DIV. */
export function fillAokanaScaledDisplacementMap(
  bitmap: AokanaBitmap,
  offsetX: number,
  offsetY: number,
  targetWidth: number,
  targetHeight: number,
): 0 | 0x80000003 | 0x80000005 {
  const width = bitmap.width | 0,
    height = bitmap.height | 0;
  if (bitmap.format >>> 0 !== 4 || width === 0 || height === 0) return 0x80000003;
  targetWidth |= 0;
  targetHeight |= 0;
  if (targetWidth === 0 || targetHeight === 0) return 0x80000005;
  let row = bitmap.offset,
    accumulatedY = 0;
  for (let y = 0; y < height; y++) {
    const dy = Math.trunc(((accumulatedY << 4) >>> 0) / (height >>> 0)) - (y << 4) + (offsetY << 4);
    let accumulatedX = 0;
    for (let x = 0; x < width; x++) {
      const dx =
        Math.trunc(((accumulatedX << 4) >>> 0) / (width >>> 0)) - (x << 4) + (offsetX << 4);
      accumulatedX = (accumulatedX + targetWidth) | 0;
      bitmapWrite16(bitmap, row + x * 4, dx);
      bitmapWrite16(bitmap, row + x * 4 + 2, dy);
    }
    row += bitmap.stride | 0;
    accumulatedY = (accumulatedY + targetHeight) | 0;
  }
  return 0;
}

/** 034710 consumes four actual CRT draws per pixel, publishing X before drawing Y. */
export function fillAokanaRandomDisplacementMap(
  bitmap: AokanaBitmap,
  radius: number,
  random: AokanaCrtRandom,
): 0 | 0x80000003 {
  const width = bitmap.width | 0,
    height = bitmap.height | 0;
  if (bitmap.format >>> 0 !== 4 || width === 0 || height === 0) return 0x80000003;
  radius |= 0;
  const divisor = (Math.imul(radius, 2) + 1) >>> 0;
  let row = bitmap.offset;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const firstX = random.next(),
        secondX = random.next();
      bitmapWrite16(bitmap, row + x * 4, radius - ((((firstX << 15) | secondX) >>> 0) % divisor));
      const firstY = random.next(),
        secondY = random.next();
      bitmapWrite16(
        bitmap,
        row + x * 4 + 2,
        radius - ((((firstY << 15) | secondY) >>> 0) % divisor),
      );
    }
    row += bitmap.stride | 0;
  }
  return 0;
}

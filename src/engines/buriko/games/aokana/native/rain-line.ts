import type {AokanaBitmap, AokanaBitmapRectangle} from './bitmap.js';
import {bitmapWrite32} from './bitmap-scalar.js';

function unsignedDivide(numerator: number, denominator: number): number {
  denominator >>>= 0;
  if (denominator === 0) throw new RangeError('Aokana rain line divides by zero');
  return Math.floor((numerator >>> 0) / denominator) >>> 0;
}

/** NCPainter32::Line, 1400f0e70. Q12 accumulation and the native asymmetric edge tests are retained. */
export function drawAokanaRainLine(
  bitmap: AokanaBitmap,
  clip: AokanaBitmapRectangle,
  color: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): void {
  x1 |= 0;
  y1 |= 0;
  x2 |= 0;
  y2 |= 0;
  if (
    (x1 < clip.left && x2 < clip.left) ||
    (x1 > clip.right && x2 > clip.right) ||
    (y1 < clip.top && y2 < clip.top) ||
    (y1 > clip.bottom && y2 > clip.bottom)
  )
    return;
  const ascending = y1 <= y2;
  let x = ascending ? x1 : x2;
  let y = ascending ? y1 : y2;
  const endX = ascending ? x2 : x1;
  const endY = ascending ? y2 : y1;
  const dx = (((x > endX ? x - endX : endX - x) | 0) + 1) >>> 0;
  const dy = (endY - y + 1) >>> 0;
  const stride = bitmap.stride >>> 0;
  const offsetAt = (column: number, row: number): number =>
    bitmap.offset + (Math.imul(stride, row) >>> 0) + column * 4;
  if (dx > dy) {
    const step = unsignedDivide(dy << 12, dx);
    let fixedY = y << 12;
    if (x <= endX) {
      if (x < clip.left) {
        fixedY = (fixedY - Math.imul(x, step)) | 0;
        x = clip.left;
      }
      const limit = (Math.min(clip.right, endX) + 1) | 0;
      while (fixedY >> 12 < clip.top) {
        fixedY = (fixedY + step) | 0;
        x = (x + 1) | 0;
      }
      y = fixedY >> 12;
      if (y >= clip.bottom) return;
      let offset = offsetAt(x, y);
      while (x < limit) {
        fixedY = (fixedY + step) | 0;
        bitmapWrite32(bitmap, offset, color);
        const nextY = fixedY >> 12;
        if (y !== nextY) {
          offset += stride;
          if (nextY > clip.bottom) return;
        }
        offset += 4;
        x = (x + 1) | 0;
        y = nextY;
      }
    } else {
      if (x > clip.right) {
        fixedY = (fixedY + Math.imul((x - clip.right) | 0, step)) | 0;
        x = clip.right;
      }
      const limit = (Math.max(clip.left, endX) - 1) | 0;
      while (fixedY >> 12 < clip.top) {
        fixedY = (fixedY + step) | 0;
        x = (x - 1) | 0;
      }
      y = fixedY >> 12;
      if (y >= clip.bottom) return;
      let offset = offsetAt(x, y);
      while (x > limit) {
        fixedY = (fixedY + step) | 0;
        bitmapWrite32(bitmap, offset, color);
        const nextY = fixedY >> 12;
        if (y !== nextY) {
          offset += stride;
          if (nextY > clip.bottom) return;
        }
        offset -= 4;
        x = (x - 1) | 0;
        y = nextY;
      }
    }
    return;
  }
  const step = unsignedDivide(dx << 12, dy);
  let positiveX = x << 12,
    negativeX = positiveX;
  if (y < clip.top) {
    negativeX = (positiveX + Math.imul(y, step)) | 0;
    positiveX = (positiveX - Math.imul(y, step)) | 0;
    y = clip.top;
  }
  const limit = (Math.min(clip.bottom, endY) + 1) | 0;
  if (x <= endX) {
    const rightLimit = (clip.right + 1) | 0;
    // Native 0f10b1 compares the Q12 accumulator directly with the unscaled left edge.
    while (positiveX < clip.left) {
      positiveX = (positiveX + step) | 0;
      y = (y + 1) | 0;
    }
    x = positiveX >> 12;
    if (x >= rightLimit) return;
    let offset = offsetAt(x, y);
    while (y < limit) {
      positiveX = (positiveX + step) | 0;
      bitmapWrite32(bitmap, offset, color);
      const nextX = positiveX >> 12;
      if (x !== nextX) {
        offset += 4;
        if (nextX >= rightLimit) return;
      }
      x = nextX;
      y = (y + 1) | 0;
      offset += stride;
    }
  } else {
    while (negativeX >> 12 > clip.right) {
      negativeX = (negativeX - step) | 0;
      y = (y + 1) | 0;
    }
    x = negativeX >> 12;
    if (x < 0) return;
    let offset = offsetAt(x, y);
    while (y < limit) {
      negativeX = (negativeX - step) | 0;
      bitmapWrite32(bitmap, offset, color);
      const nextX = negativeX >> 12;
      if (x !== nextX) {
        offset -= 4;
        if (nextX < 0) return;
      }
      x = nextX;
      y = (y + 1) | 0;
      offset += stride;
    }
  }
}

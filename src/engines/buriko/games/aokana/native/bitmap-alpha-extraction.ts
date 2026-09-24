import {
  aokanaBitmapRectangle,
  cropAokanaBitmap,
  intersectAokanaBitmapRectangle,
  translateAokanaBitmapRectangle,
  type AokanaBitmap,
} from './bitmap.js';
import {clearAokanaBitmap} from './bitmap-copy.js';
import {bitmapRead8, bitmapRead32, bitmapWrite8} from './bitmap-scalar.js';

/**053D90 dispatches actual alpha extraction, leaving unsupported interiors unwritten. */
function extract(
  destination: AokanaBitmap,
  first: AokanaBitmap,
  second: AokanaBitmap | null,
  level: number,
): number {
  if (destination.format !== 3) return 7;
  if (second !== null && first.format !== second.format) return 1;
  if (first.format !== 2) return 0;
  for (let y = 0; y < destination.height >>> 0; y++) {
    const output = destination.offset + y * (destination.stride | 0);
    const input = first.offset + y * (first.stride | 0);
    for (let x = 0; x < destination.width >>> 0; x++) {
      if (second === null)
        bitmapWrite8(destination, output + x, bitmapRead32(first, input + x * 4) >>> 24);
      else {
        const a = bitmapRead8(first, input + x * 4 + 3);
        const b = bitmapRead8(second, second.offset + y * (second.stride | 0) + x * 4 + 3);
        bitmapWrite8(destination, output + x, (Math.imul(b - a, level) >>> 8) + a);
      }
    }
  }
  return 0;
}

/**054A20 keeps original offsets in exterior strips, including after negative-position clipping. */
export function extractAokanaBitmapAlpha(
  destination: AokanaBitmap,
  x: number,
  y: number,
  first: AokanaBitmap,
  second: AokanaBitmap | null,
  level: number,
): number {
  x |= 0;
  y |= 0;
  const target = {...destination},
    firstCopy = {...first},
    secondCopy = {...(second ?? first)};
  const outputRectangle = aokanaBitmapRectangle(target);
  translateAokanaBitmapRectangle(outputRectangle, -x | 0, -y | 0);
  const overlap = aokanaBitmapRectangle(firstCopy);
  intersectAokanaBitmapRectangle(overlap, aokanaBitmapRectangle(secondCopy));
  if (!intersectAokanaBitmapRectangle(overlap, outputRectangle)) {
    clearAokanaBitmap(destination);
    return 0;
  }
  cropAokanaBitmap(firstCopy, overlap);
  cropAokanaBitmap(secondCopy, overlap);
  translateAokanaBitmapRectangle(overlap, x, y);
  cropAokanaBitmap(target, overlap);
  const status = extract(target, firstCopy, second === null ? null : secondCopy, level);
  if (status !== 0) return status;
  if (y > 0)
    clearAokanaBitmap(destination, {...aokanaBitmapRectangle(destination), bottom: (y - 1) | 0});
  const bottom = (target.height + y) | 0;
  if (x > 0)
    clearAokanaBitmap(destination, {left: 0, top: y, right: (x - 1) | 0, bottom: (bottom - 1) | 0});
  const right = (target.width + x) | 0;
  if (right >>> 0 < destination.width >>> 0)
    clearAokanaBitmap(destination, {
      left: right,
      top: y,
      right: (destination.width - 1) | 0,
      bottom: (bottom - 1) | 0,
    });
  if (bottom >>> 0 < destination.height >>> 0)
    clearAokanaBitmap(destination, {...aokanaBitmapRectangle(destination), top: bottom});
  return 0;
}

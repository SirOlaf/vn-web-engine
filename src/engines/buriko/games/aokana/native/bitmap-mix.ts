import type {AokanaBitmap} from './bitmap.js';
import type {AokanaDistributedProcessing} from './distributed-processing.js';
import {bitmapRead32, bitmapWrite32} from './bitmap-scalar.js';
import {
  aokanaSignedProduct16,
  readAokanaPixelPair,
  saturateAokanaByte,
  writeAokanaPixelPair,
} from './bitmap-pairs.js';
import {aokanaRosettaSseReciprocal} from './cpu-numerical-profile.js';
import {runAokanaBitmapOperation} from './bitmap-operation-jobs.js';

const signed16 = (value: number): number => (value << 16) >> 16;
function mixRgb(first: number, second: number, factor: number): number {
  const multiplier = signed16(factor << 4);
  let result = 0;
  for (let shift = 0; shift < 32; shift += 8) {
    const base = (first >>> shift) & 255;
    const difference = signed16((((second >>> shift) & 255) - base) << 4);
    const value = signed16((Math.imul(difference, multiplier) >> 16) + base);
    result |= saturateAokanaByte(value) << shift;
  }
  return result >>> 0;
}
function mixAlpha(first: number, second: number, factor: number): number {
  const firstAlpha = Math.imul(first >>> 24, signed16(256 - factor));
  const secondAlpha = Math.imul(second >>> 24, signed16(factor));
  const alpha = (firstAlpha + secondAlpha) | 0;
  const reciprocal = aokanaRosettaSseReciprocal(Math.fround(alpha === 0 ? 1 : alpha));
  const quotient = Math.fround(reciprocal * Math.fround(firstAlpha << 7));
  const converted =
    !Number.isFinite(quotient) || quotient < -2147483648 || quotient >= 2147483648
      ? -2147483648
      : Math.trunc(quotient);
  const coefficient = converted & 65535;
  if (coefficient > 128)
    throw new RangeError('Aokana alpha mix coefficient exceeds its native table');
  let result = saturateAokanaByte(signed16(alpha >> 8)) << 24;
  for (let shift = 0; shift < 24; shift += 8) {
    const base = (second >>> shift) & 255;
    const product = aokanaSignedProduct16(((first >>> shift) & 255) - base, coefficient);
    result |= saturateAokanaByte(signed16((product >> 7) + base)) << shift;
  }
  return result >>> 0;
}

/** 03c370 / 03bef0, with MOVQ pairs then one MOVD and native pointer-equality traversal. */
function mixRows(
  destination: AokanaBitmap,
  first: AokanaBitmap,
  second: AokanaBitmap,
  factor: number,
): void {
  const width = Math.min(first.width >>> 0, second.width >>> 0);
  const height = Math.min(first.height >>> 0, second.height >>> 0);
  const same = destination.storage === first.storage && destination.offset === first.offset;
  const firstStride = same ? destination.stride : first.stride;
  const mix = destination.format === 1 ? mixRgb : mixAlpha;
  for (let row = 0; row < height; row++) {
    const target = destination.offset + row * (destination.stride | 0);
    const left = first.offset + row * (firstStride | 0),
      right = second.offset + row * (second.stride | 0);
    let column = 0;
    for (; column + 1 < width; column += 2) {
      const a = readAokanaPixelPair(first, left + column * 4);
      const b = readAokanaPixelPair(second, right + column * 4);
      writeAokanaPixelPair(destination, target + column * 4, [
        mix(a[0], b[0], factor),
        mix(a[1], b[1], factor),
      ]);
    }
    if (column < width)
      bitmapWrite32(
        destination,
        target + column * 4,
        mix(
          bitmapRead32(first, left + column * 4),
          bitmapRead32(second, right + column * 4),
          factor,
        ),
      );
  }
}

/** 040fd0, including its actual descriptor-only distributed callback at 0542f0. */
export function mixAokanaBitmaps(
  destination: AokanaBitmap,
  first: AokanaBitmap,
  second: AokanaBitmap,
  factor: number,
  processing: AokanaDistributedProcessing | null = null,
  distributed = 1,
): 0 | 9 | 10 {
  if ((destination.format - 1) >>> 0 > 1) return 10;
  if (first.format !== second.format || destination.format !== first.format) return 9;
  if (
    distributed !== 0 &&
    runAokanaBitmapOperation(processing, [destination, first, second], first, 0, (bitmaps) => {
      mixAokanaBitmaps(bitmaps[0]!, bitmaps[1]!, bitmaps[2]!, factor, processing, 0);
    })
  )
    return 0;
  mixRows(destination, first, second, factor);
  return 0;
}

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

const signedHighWord = (first: number, second: number): number =>
  (Math.imul(signed16(first), signed16(second)) >> 16) | 0;

function fusedPremultipliedChannel(
  first: number,
  second: number,
  destination: number,
  firstAlpha: number,
  secondAlpha: number,
  factor: number,
  transparency: number,
): number {
  const opacity = (256 - transparency) | 0,
    firstScaledAlpha = Math.imul(firstAlpha, opacity) >>> 8,
    secondScaledAlpha = Math.imul(secondAlpha, opacity) >>> 8,
    firstPremultiplied = signedHighWord(first << 4, firstScaledAlpha << 4),
    secondPremultiplied = signedHighWord(second << 4, secondScaledAlpha << 4),
    mixed =
      firstPremultiplied +
      signedHighWord((secondPremultiplied - firstPremultiplied) << 4, factor << 4),
    alpha =
      firstScaledAlpha + signedHighWord((secondScaledAlpha - firstScaledAlpha) << 4, factor << 4),
    retained = signedHighWord(destination << 4, (256 - alpha) << 4);
  return saturateAokanaByte((mixed + retained) | 0);
}

function fusedMixedAlpha(
  firstAlpha: number,
  secondAlpha: number,
  factor: number,
  transparency: number,
): number {
  const opacity = (256 - transparency) | 0,
    firstScaledAlpha = Math.imul(firstAlpha, opacity) >>> 8,
    secondScaledAlpha = Math.imul(secondAlpha, opacity) >>> 8;
  return (
    (firstScaledAlpha + signedHighWord((secondScaledAlpha - firstScaledAlpha) << 4, factor << 4)) &
    0xffff
  );
}

function fusedMixedPixel(
  firstPixel: number,
  secondPixel: number,
  destinationPixel: number,
  factor: number,
  transparency: number,
): number {
  const firstAlpha = firstPixel >>> 24,
    secondAlpha = secondPixel >>> 24;
  let output = 0;
  for (let shift = 0; shift < 24; shift += 8)
    output |=
      fusedPremultipliedChannel(
        (firstPixel >>> shift) & 255,
        (secondPixel >>> shift) & 255,
        (destinationPixel >>> shift) & 255,
        firstAlpha,
        secondAlpha,
        factor,
        transparency,
      ) << shift;
  return output >>> 0;
}

/** 03C8B0/03C580 fuse RGBA crossfade, transparency and RGB destination blending. */
export function blendMixedAokanaBitmapsIntoRgb(
  destination: AokanaBitmap,
  first: AokanaBitmap,
  second: AokanaBitmap,
  factor: number,
  transparency: number,
): 0 | 9 | 10 {
  if (destination.format !== 1) return 10;
  if (first.format !== 2 || second.format !== 2) return 9;
  if (transparency >>> 0 >= 256) return 0;
  const width = Math.min(destination.width >>> 0, first.width >>> 0, second.width >>> 0),
    height = Math.min(destination.height >>> 0, first.height >>> 0, second.height >>> 0);
  factor = signed16(factor);
  transparency |= 0;
  for (let row = 0; row < height; row++) {
    const destinationRow = destination.offset + row * destination.stride,
      firstRow = first.offset + row * first.stride,
      secondRow = second.offset + row * second.stride;
    let column = 0;
    for (; column + 1 < width; column += 2) {
      // 03C700 loads both source pairs before either destination store.
      const firstPixel0 = bitmapRead32(first, firstRow + column * 4),
        firstPixel1 = bitmapRead32(first, firstRow + column * 4 + 4),
        secondPixel0 = bitmapRead32(second, secondRow + column * 4),
        secondPixel1 = bitmapRead32(second, secondRow + column * 4 + 4),
        alpha0 = fusedMixedAlpha(firstPixel0 >>> 24, secondPixel0 >>> 24, factor, transparency),
        alpha1 = fusedMixedAlpha(firstPixel1 >>> 24, secondPixel1 >>> 24, factor, transparency);
      if (alpha0 === 0 && alpha1 === 0) continue;
      const destinationOffset = destinationRow + column * 4,
        old0 = bitmapRead32(destination, destinationOffset),
        old1 = bitmapRead32(destination, destinationOffset + 4),
        output0 = fusedMixedPixel(firstPixel0, secondPixel0, old0, factor, transparency),
        output1 = fusedMixedPixel(firstPixel1, secondPixel1, old1, factor, transparency);
      bitmapWrite32(destination, destinationOffset, output0);
      bitmapWrite32(destination, destinationOffset + 4, output1);
    }
    if (column < width) {
      const firstPixel = bitmapRead32(first, firstRow + column * 4),
        secondPixel = bitmapRead32(second, secondRow + column * 4);
      if (fusedMixedAlpha(firstPixel >>> 24, secondPixel >>> 24, factor, transparency) !== 0) {
        const destinationOffset = destinationRow + column * 4,
          old = bitmapRead32(destination, destinationOffset);
        bitmapWrite32(
          destination,
          destinationOffset,
          fusedMixedPixel(firstPixel, secondPixel, old, factor, transparency),
        );
      }
    }
  }
  return 0;
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

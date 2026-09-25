import {initializedAokanaBitmapView, type AokanaBitmap} from './bitmap.js';
import {AOKANA_BITMAP_WASM_MIN_PIXELS, tryAokanaBitmapFusedWasm} from './bitmap-alpha-wasm.js';
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
  firstScaledAlpha: number,
  secondScaledAlpha: number,
  factor: number,
  alpha: number,
): number {
  const firstPremultiplied = signedHighWord(first << 4, firstScaledAlpha << 4),
    secondPremultiplied = signedHighWord(second << 4, secondScaledAlpha << 4),
    mixed =
      firstPremultiplied +
      signedHighWord((secondPremultiplied - firstPremultiplied) << 4, factor << 4),
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
  const opacity = (256 - transparency) | 0,
    firstScaledAlpha = Math.imul(firstPixel >>> 24, opacity) >>> 8,
    secondScaledAlpha = Math.imul(secondPixel >>> 24, opacity) >>> 8,
    alpha =
      firstScaledAlpha + signedHighWord((secondScaledAlpha - firstScaledAlpha) << 4, factor << 4);
  let output = 0;
  for (let shift = 0; shift < 24; shift += 8)
    output |=
      fusedPremultipliedChannel(
        (firstPixel >>> shift) & 255,
        (secondPixel >>> shift) & 255,
        (destinationPixel >>> shift) & 255,
        firstScaledAlpha,
        secondScaledAlpha,
        factor,
        alpha,
      ) << shift;
  return output >>> 0;
}

/** Bounded coefficients make each signed word exact and each saturation an identity. */
function blendInitializedMixedIntoRgb(
  destination: AokanaBitmap,
  first: AokanaBitmap,
  second: AokanaBitmap,
  destinationView: DataView,
  firstView: DataView,
  secondView: DataView,
  width: number,
  height: number,
  factor: number,
  transparency: number,
): void {
  const inverse = 256 - factor,
    opacity = 256 - transparency;
  const mix = (
    firstPixel: number,
    secondPixel: number,
    destinationPixel: number,
    firstAlpha: number,
    secondAlpha: number,
    alpha: number,
  ): number => {
    // Positive weighted sums preserve the native floor at every stage. The
    // red/blue byte lanes never carry into one another, including the final
    // sum: each mixed channel is <= alpha, and its retained part <= 255-alpha.
    const retainedWeight = 256 - alpha,
      firstRedBlue = (Math.imul(firstPixel & 0xff00ff, firstAlpha) >>> 8) & 0xff00ff,
      secondRedBlue = (Math.imul(secondPixel & 0xff00ff, secondAlpha) >>> 8) & 0xff00ff,
      mixedRedBlue =
        ((Math.imul(firstRedBlue, inverse) + Math.imul(secondRedBlue, factor)) >>> 8) & 0xff00ff,
      retainedRedBlue = (Math.imul(destinationPixel & 0xff00ff, retainedWeight) >>> 8) & 0xff00ff,
      firstGreen = (((firstPixel >>> 8) & 255) * firstAlpha) >>> 8,
      secondGreen = (((secondPixel >>> 8) & 255) * secondAlpha) >>> 8,
      mixedGreen = (firstGreen * inverse + secondGreen * factor) >>> 8,
      retainedGreen = (((destinationPixel >>> 8) & 255) * retainedWeight) >>> 8;
    return (mixedRedBlue + retainedRedBlue + ((mixedGreen + retainedGreen) << 8)) >>> 0;
  };
  for (let row = 0; row < height; row++) {
    const destinationRow = destination.offset + row * destination.stride,
      firstRow = first.offset + row * first.stride,
      secondRow = second.offset + row * second.stride;
    let column = 0;
    for (; column + 1 < width; column += 2) {
      // As with the native MOVQs, load both source pairs before either store.
      const firstOffset = firstRow + column * 4,
        secondOffset = secondRow + column * 4,
        first0 = firstView.getUint32(firstOffset, true),
        first1 = firstView.getUint32(firstOffset + 4, true),
        second0 = secondView.getUint32(secondOffset, true),
        second1 = secondView.getUint32(secondOffset + 4, true),
        firstAlpha0 = ((first0 >>> 24) * opacity) >>> 8,
        firstAlpha1 = ((first1 >>> 24) * opacity) >>> 8,
        secondAlpha0 = ((second0 >>> 24) * opacity) >>> 8,
        secondAlpha1 = ((second1 >>> 24) * opacity) >>> 8,
        alpha0 = (firstAlpha0 * inverse + secondAlpha0 * factor) >>> 8,
        alpha1 = (firstAlpha1 * inverse + secondAlpha1 * factor) >>> 8;
      if (alpha0 === 0 && alpha1 === 0) continue;
      const offset = destinationRow + column * 4,
        old0 = destinationView.getUint32(offset, true),
        old1 = destinationView.getUint32(offset + 4, true),
        output0 = mix(first0, second0, old0, firstAlpha0, secondAlpha0, alpha0),
        output1 = mix(first1, second1, old1, firstAlpha1, secondAlpha1, alpha1);
      destinationView.setUint32(offset, output0, true);
      destinationView.setUint32(offset + 4, output1, true);
    }
    if (column < width) {
      const firstPixel = firstView.getUint32(firstRow + column * 4, true),
        secondPixel = secondView.getUint32(secondRow + column * 4, true),
        firstAlpha = ((firstPixel >>> 24) * opacity) >>> 8,
        secondAlpha = ((secondPixel >>> 24) * opacity) >>> 8,
        alpha = (firstAlpha * inverse + secondAlpha * factor) >>> 8;
      if (alpha === 0) continue;
      const offset = destinationRow + column * 4,
        old = destinationView.getUint32(offset, true);
      destinationView.setUint32(
        offset,
        mix(firstPixel, secondPixel, old, firstAlpha, secondAlpha, alpha),
        true,
      );
    }
  }
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
  const firstView = initializedAokanaBitmapView(first, width, height),
    secondView = initializedAokanaBitmapView(second, width, height),
    destinationView = initializedAokanaBitmapView(destination, width, height);
  if (
    firstView !== null &&
    secondView !== null &&
    destinationView !== null &&
    factor >= 0 &&
    factor <= 256
  ) {
    if (
      width * height >= AOKANA_BITMAP_WASM_MIN_PIXELS &&
      tryAokanaBitmapFusedWasm(
        destination,
        first,
        second,
        destinationView,
        firstView,
        secondView,
        width,
        height,
        factor,
        transparency,
      )
    )
      return 0;
    blendInitializedMixedIntoRgb(
      destination,
      first,
      second,
      destinationView,
      firstView,
      secondView,
      width,
      height,
      factor,
      transparency,
    );
    return 0;
  }
  for (let row = 0; row < height; row++) {
    const destinationRow = destination.offset + row * destination.stride,
      firstRow = first.offset + row * first.stride,
      secondRow = second.offset + row * second.stride;
    let column = 0;
    for (; column + 1 < width; column += 2) {
      // 03C700 loads both source pairs before either destination store.
      const firstOffset = firstRow + column * 4,
        secondOffset = secondRow + column * 4;
      const firstPixel0 =
          firstView === null
            ? bitmapRead32(first, firstOffset)
            : firstView.getUint32(firstOffset, true),
        firstPixel1 =
          firstView === null
            ? bitmapRead32(first, firstOffset + 4)
            : firstView.getUint32(firstOffset + 4, true),
        secondPixel0 =
          secondView === null
            ? bitmapRead32(second, secondOffset)
            : secondView.getUint32(secondOffset, true),
        secondPixel1 =
          secondView === null
            ? bitmapRead32(second, secondOffset + 4)
            : secondView.getUint32(secondOffset + 4, true),
        alpha0 = fusedMixedAlpha(firstPixel0 >>> 24, secondPixel0 >>> 24, factor, transparency),
        alpha1 = fusedMixedAlpha(firstPixel1 >>> 24, secondPixel1 >>> 24, factor, transparency);
      if (alpha0 === 0 && alpha1 === 0) continue;
      const destinationOffset = destinationRow + column * 4,
        old0 =
          destinationView === null
            ? bitmapRead32(destination, destinationOffset)
            : destinationView.getUint32(destinationOffset, true),
        old1 =
          destinationView === null
            ? bitmapRead32(destination, destinationOffset + 4)
            : destinationView.getUint32(destinationOffset + 4, true),
        output0 = fusedMixedPixel(firstPixel0, secondPixel0, old0, factor, transparency),
        output1 = fusedMixedPixel(firstPixel1, secondPixel1, old1, factor, transparency);
      if (destinationView === null) {
        bitmapWrite32(destination, destinationOffset, output0);
        bitmapWrite32(destination, destinationOffset + 4, output1);
      } else {
        destinationView.setUint32(destinationOffset, output0, true);
        destinationView.setUint32(destinationOffset + 4, output1, true);
      }
    }
    if (column < width) {
      const firstOffset = firstRow + column * 4,
        secondOffset = secondRow + column * 4;
      const firstPixel =
          firstView === null
            ? bitmapRead32(first, firstOffset)
            : firstView.getUint32(firstOffset, true),
        secondPixel =
          secondView === null
            ? bitmapRead32(second, secondOffset)
            : secondView.getUint32(secondOffset, true);
      if (fusedMixedAlpha(firstPixel >>> 24, secondPixel >>> 24, factor, transparency) !== 0) {
        const destinationOffset = destinationRow + column * 4,
          old =
            destinationView === null
              ? bitmapRead32(destination, destinationOffset)
              : destinationView.getUint32(destinationOffset, true),
          output = fusedMixedPixel(firstPixel, secondPixel, old, factor, transparency);
        if (destinationView === null) bitmapWrite32(destination, destinationOffset, output);
        else destinationView.setUint32(destinationOffset, output, true);
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

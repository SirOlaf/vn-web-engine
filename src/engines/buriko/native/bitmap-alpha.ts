import {isRasterTextPresentation} from '../../../text/raster-text.js';
import {withBurikoBitmapText} from './bitmap-dom-text.js';
import {initializedBurikoBitmapView, type BurikoBitmap} from './bitmap.js';
import {bitmapRead32, bitmapWrite32} from './bitmap-scalar.js';
import {BURIKO_BITMAP_WASM_MIN_PIXELS, tryBurikoBitmapAlphaWasm} from './bitmap-alpha-wasm.js';
import {
  burikoAlphaHalfCoefficient,
  burikoSignedProduct16,
  readBurikoPixelPair,
  readBurikoPixelPairInto,
  saturateBurikoByte,
  visitBurikoPixelPairsReusingSource,
  writeBurikoPixelPair,
  writeBurikoPixelPairValues,
} from './bitmap-pairs.js';

import {burikoRosettaSseReciprocal} from './cpu-numerical-profile.js';
export {burikoRosettaSseReciprocal} from './cpu-numerical-profile.js';
const f32 = Math.fround;

function weightedRgb(
  source: number,
  destination: number,
  sourceWeight: number,
  destinationWeight: number,
  alpha: number,
): number {
  let pixel = alpha << 24;
  for (let shift = 0; shift < 24; shift += 8) {
    const product =
      Math.imul((source >>> shift) & 255, sourceWeight) +
      Math.imul((destination >>> shift) & 255, destinationWeight);
    pixel |= ((product & 65535) >>> 8) << shift;
  }
  return pixel >>> 0;
}

/** Shared reciprocal pair path used by RGBA-over-RGBA and format-three glyph masks. */
export function burikoAlphaPairPixel(
  source: number,
  destination: number,
  destinationWeight: number,
): number {
  const sourceAlpha = f32((source >>> 24) * f32((256 - destinationWeight) / 256));
  const destinationAlpha = f32(f32((destination >>> 24) / 256) * f32(256 - sourceAlpha));
  const alpha = f32(sourceAlpha + destinationAlpha);
  const reciprocal = burikoRosettaSseReciprocal(alpha === 0 ? 1 : alpha);
  const sourceCoefficient = Math.trunc(f32(f32(reciprocal * sourceAlpha) * 256));
  const destinationCoefficient = Math.trunc(f32(f32(reciprocal * destinationAlpha) * 256));
  return weightedRgb(
    source,
    destination,
    sourceCoefficient,
    destinationCoefficient,
    Math.trunc(alpha),
  );
}

/** Shared scalar integer tail used by RGBA-over-RGBA and format-three glyph masks. */
export function burikoAlphaTailPixel(
  source: number,
  destination: number,
  destinationWeight: number,
): number {
  const sourceAlpha = Math.imul(source >>> 24, 256 - destinationWeight) >>> 0;
  const destinationAlpha = Math.imul(destination >>> 24, 65536 - sourceAlpha) >>> 8;
  const denominator = (sourceAlpha + destinationAlpha) >>> 0;
  if (denominator === 0) {
    if (isRasterTextPresentation()) return 0;
    throw new RangeError('Buriko bitmap native unsigned division by zero');
  }
  return weightedRgb(
    source,
    destination,
    Math.trunc(((sourceAlpha << 8) >>> 0) / denominator),
    Math.trunc(((destinationAlpha << 8) >>> 0) / denominator),
    denominator >>> 8,
  );
}

/** 14003d690: normal format-2 over format-2, with native pair shortcuts and integer tail. */
function blendBurikoAlphaPixels(destination: BurikoBitmap, source: BurikoBitmap): void {
  // One scratch tuple per operation avoids allocating a destination pair for
  // every pixel pair. Read both values before writing to preserve MOVQ overlap.
  const oldPixels: [number, number] = [0, 0];
  visitBurikoPixelPairsReusingSource(
    destination,
    source,
    (pixels, offset) => {
      if (pixels[0] >>> 24 === 0 && pixels[1] >>> 24 === 0) return;
      if (pixels[0] >>> 24 === 255 && pixels[1] >>> 24 === 255) {
        writeBurikoPixelPair(destination, offset, pixels);
        return;
      }
      readBurikoPixelPairInto(destination, offset, oldPixels);
      writeBurikoPixelPairValues(
        destination,
        offset,
        burikoAlphaPairPixel(pixels[0], oldPixels[0], 0),
        burikoAlphaPairPixel(pixels[1], oldPixels[1], 0),
      );
    },
    (pixel, offset) => {
      if (pixel >>> 24 === 0) return;
      bitmapWrite32(
        destination,
        offset,
        pixel >>> 24 === 255
          ? pixel
          : burikoAlphaTailPixel(pixel, bitmapRead32(destination, offset), 0),
      );
    },
  );
}

/** 14003ca70: destinationWeight is native transparency, not source opacity. */
function blendBurikoAlphaWithTransparencyPixels(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  destinationWeight: number,
): void {
  visitBurikoPixelPairsReusingSource(
    destination,
    source,
    (pixels, offset) => {
      if (pixels[0] >>> 24 === 0 && pixels[1] >>> 24 === 0) return;
      const old = readBurikoPixelPair(destination, offset);
      writeBurikoPixelPair(destination, offset, [
        burikoAlphaPairPixel(pixels[0], old[0], destinationWeight),
        burikoAlphaPairPixel(pixels[1], old[1], destinationWeight),
      ]);
    },
    (pixel, offset) => {
      if (pixel >>> 24 !== 0)
        bitmapWrite32(
          destination,
          offset,
          burikoAlphaTailPixel(pixel, bitmapRead32(destination, offset), destinationWeight),
        );
    },
  );
}

function rgbDifference(source: number, destination: number, weight: number): number {
  if (weight >= 0 && weight <= 128) {
    // In this interval the signed 16-bit products cannot wrap, and the result
    // cannot saturate. Two separated byte lanes fit in one 32-bit product.
    const inverse = 128 - weight,
      redBlue =
        ((Math.imul(source & 0xff00ff, weight) + Math.imul(destination & 0xff00ff, inverse)) >>>
          7) &
        0xff00ff,
      green =
        ((((source >>> 8) & 255) * weight + ((destination >>> 8) & 255) * inverse) >>> 7) << 8;
    return ((destination & 0xff000000) | redBlue | green) >>> 0;
  }
  let pixel = destination & 0xff000000;
  for (let shift = 0; shift < 24; shift += 8) {
    const old = (destination >>> shift) & 255;
    const difference = ((source >>> shift) & 255) - old;
    pixel |= saturateBurikoByte(old + (burikoSignedProduct16(difference, weight) >> 7)) << shift;
  }
  return pixel >>> 0;
}

/** The common initialized surface path keeps MOVQ load/store order without tuple allocation. */
function blendInitializedAlphaIntoRgb(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  transparency: number | null,
): boolean {
  const width = source.width >>> 0,
    height = source.height >>> 0;
  const input = initializedBurikoBitmapView(source, width, height),
    output = initializedBurikoBitmapView(destination, width, height);
  // No eager faults: partially initialized or invalid descriptors retain the
  // checked path below, including stores completed before a later access faults.
  if (input === null || output === null) return false;
  if (
    width * height >= BURIKO_BITMAP_WASM_MIN_PIXELS &&
    tryBurikoBitmapAlphaWasm(destination, source, output, input, width, height, transparency)
  )
    return true;
  const opacity = transparency === null ? 0 : 256 - transparency;
  for (let row = 0; row < height; row++) {
    const sourceRow = source.offset + row * source.stride,
      destinationRow = destination.offset + row * destination.stride;
    let column = 0;
    for (; column + 1 < width; column += 2) {
      const sourceOffset = sourceRow + column * 4,
        offset = destinationRow + column * 4;
      const first = input.getUint32(sourceOffset, true),
        second = input.getUint32(sourceOffset + 4, true),
        firstAlpha = first >>> 24,
        secondAlpha = second >>> 24;
      if (firstAlpha === 0 && secondAlpha === 0) continue;
      if (transparency === null && firstAlpha >= 254 && secondAlpha >= 254) {
        output.setUint32(offset, first, true);
        output.setUint32(offset + 4, second, true);
        continue;
      }
      const oldFirst = output.getUint32(offset, true),
        oldSecond = output.getUint32(offset + 4, true);
      const resultFirst = rgbDifference(
          first,
          oldFirst,
          transparency === null
            ? burikoAlphaHalfCoefficient(firstAlpha)
            : Math.imul(first >>> 25, opacity) >>> 8,
        ),
        resultSecond = rgbDifference(
          second,
          oldSecond,
          transparency === null
            ? burikoAlphaHalfCoefficient(secondAlpha)
            : Math.imul(second >>> 25, opacity) >>> 8,
        );
      output.setUint32(offset, resultFirst, true);
      output.setUint32(offset + 4, resultSecond, true);
    }
    if (column < width) {
      const pixel = input.getUint32(sourceRow + column * 4, true),
        alpha = pixel >>> 24;
      if (alpha < 2) continue;
      const offset = destinationRow + column * 4;
      const result =
        transparency === null && alpha >= 254
          ? pixel & 0xffffff
          : rgbDifference(
              pixel,
              output.getUint32(offset, true),
              transparency === null ? alpha >>> 1 : Math.imul(pixel >>> 25, opacity) >>> 8,
            );
      output.setUint32(offset, result, true);
    }
  }
  return true;
}

/** 14003d950 has deliberately different alpha-byte handling in its opaque pair and tail. */
function blendBurikoAlphaIntoRgbPixels(destination: BurikoBitmap, source: BurikoBitmap): void {
  if (blendInitializedAlphaIntoRgb(destination, source, null)) return;
  visitBurikoPixelPairsReusingSource(
    destination,
    source,
    (pixels, offset) => {
      if (pixels[0] >>> 24 === 0 && pixels[1] >>> 24 === 0) return;
      if (pixels[0] >>> 24 >= 254 && pixels[1] >>> 24 >= 254) {
        writeBurikoPixelPair(destination, offset, pixels);
        return;
      }
      const old = readBurikoPixelPair(destination, offset);
      writeBurikoPixelPair(destination, offset, [
        rgbDifference(pixels[0], old[0], burikoAlphaHalfCoefficient(pixels[0] >>> 24)),
        rgbDifference(pixels[1], old[1], burikoAlphaHalfCoefficient(pixels[1] >>> 24)),
      ]);
    },
    (pixel, offset) => {
      const alpha = pixel >>> 24;
      if (alpha < 2) return;
      bitmapWrite32(
        destination,
        offset,
        alpha >= 254
          ? pixel & 0xffffff
          : rgbDifference(pixel, bitmapRead32(destination, offset), alpha >>> 1),
      );
    },
  );
}

/** 14003cd30's prefetch branches use the same 128-entry, truncated opacity table. */
function blendBurikoAlphaIntoRgbWithTransparencyPixels(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  transparency: number,
): void {
  if (blendInitializedAlphaIntoRgb(destination, source, transparency)) return;
  const coefficient = (pixel: number): number => Math.imul(pixel >>> 25, 256 - transparency) >>> 8;
  visitBurikoPixelPairsReusingSource(
    destination,
    source,
    (pixels, offset) => {
      if (pixels[0] >>> 24 === 0 && pixels[1] >>> 24 === 0) return;
      const old = readBurikoPixelPair(destination, offset);
      writeBurikoPixelPair(destination, offset, [
        rgbDifference(pixels[0], old[0], coefficient(pixels[0])),
        rgbDifference(pixels[1], old[1], coefficient(pixels[1])),
      ]);
    },
    (pixel, offset) => {
      if (pixel >>> 24 >= 2)
        bitmapWrite32(
          destination,
          offset,
          rgbDifference(pixel, bitmapRead32(destination, offset), coefficient(pixel)),
        );
    },
  );
}

/** 14003d3f0 blends all four bytes using transparency>>1 and signed 16-bit differences. */
function mixBurikoAllChannelsPixels(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  transparency: number,
): void {
  const coefficient = transparency >>> 1;
  const mix = (pixel: number, old: number): number => {
    if (coefficient <= 128) {
      const inverse = 128 - coefficient,
        redBlue =
          ((Math.imul(pixel & 0xff00ff, inverse) + Math.imul(old & 0xff00ff, coefficient)) >>> 7) &
          0xff00ff,
        greenAlpha =
          ((Math.imul((pixel >>> 8) & 0xff00ff, inverse) +
            Math.imul((old >>> 8) & 0xff00ff, coefficient)) >>>
            7) &
          0xff00ff;
      return (redBlue | (greenAlpha << 8)) >>> 0;
    }
    let result = 0;
    for (let shift = 0; shift < 32; shift += 8) {
      const channel = (pixel >>> shift) & 255;
      const difference = ((old >>> shift) & 255) - channel;
      result |=
        saturateBurikoByte(channel + (burikoSignedProduct16(difference, coefficient) >> 7)) <<
        shift;
    }
    return result >>> 0;
  };
  const width = source.width >>> 0,
    height = source.height >>> 0,
    input = initializedBurikoBitmapView(source, width, height),
    output = initializedBurikoBitmapView(destination, width, height);
  if (input !== null && output !== null) {
    if (
      width * height >= BURIKO_BITMAP_WASM_MIN_PIXELS &&
      tryBurikoBitmapAlphaWasm(
        destination,
        source,
        output,
        input,
        width,
        height,
        transparency,
        true,
      )
    )
      return;
    for (let row = 0; row < height; row++) {
      const sourceRow = source.offset + row * source.stride,
        destinationRow = destination.offset + row * destination.stride;
      let column = 0;
      for (; column + 1 < width; column += 2) {
        const sourceOffset = sourceRow + column * 4,
          offset = destinationRow + column * 4;
        const first = input.getUint32(sourceOffset, true),
          second = input.getUint32(sourceOffset + 4, true),
          oldFirst = output.getUint32(offset, true),
          oldSecond = output.getUint32(offset + 4, true),
          resultFirst = mix(first, oldFirst),
          resultSecond = mix(second, oldSecond);
        output.setUint32(offset, resultFirst, true);
        output.setUint32(offset + 4, resultSecond, true);
      }
      if (column < width) {
        const offset = destinationRow + column * 4;
        output.setUint32(
          offset,
          mix(input.getUint32(sourceRow + column * 4, true), output.getUint32(offset, true)),
          true,
        );
      }
    }
    return;
  }
  visitBurikoPixelPairsReusingSource(
    destination,
    source,
    (pixels, offset) => {
      const old = readBurikoPixelPair(destination, offset);
      writeBurikoPixelPair(destination, offset, [mix(pixels[0], old[0]), mix(pixels[1], old[1])]);
    },
    (pixel, offset) =>
      bitmapWrite32(destination, offset, mix(pixel, bitmapRead32(destination, offset))),
  );
}

export const blendBurikoAlpha = withBurikoBitmapText(blendBurikoAlphaPixels);

export const blendBurikoAlphaIntoRgb = withBurikoBitmapText(blendBurikoAlphaIntoRgbPixels);

export const blendBurikoAlphaWithTransparency = withBurikoBitmapText(
  blendBurikoAlphaWithTransparencyPixels,
  {opacity: (args) => (256 - args[2]) / 256},
);

export const blendBurikoAlphaIntoRgbWithTransparency = withBurikoBitmapText(
  blendBurikoAlphaIntoRgbWithTransparencyPixels,
  {opacity: (args) => (256 - args[2]) / 256},
);

export const mixBurikoAllChannels = withBurikoBitmapText(mixBurikoAllChannelsPixels, {
  opacity: (args) => (256 - args[2]) / 256,
});

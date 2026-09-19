import type {AokanaBitmap} from './bitmap.js';
import {bitmapRead32, bitmapWrite32} from './bitmap-scalar.js';
import {
  aokanaAlphaHalfCoefficient,
  aokanaSignedProduct16,
  readAokanaPixelPair,
  saturateAokanaByte,
  visitAokanaPixelPairs,
  writeAokanaPixelPair,
} from './bitmap-pairs.js';

import {aokanaRosettaSseReciprocal} from './cpu-numerical-profile.js';
export {aokanaRosettaSseReciprocal} from './cpu-numerical-profile.js';
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
export function aokanaAlphaPairPixel(
  source: number,
  destination: number,
  destinationWeight: number,
): number {
  const sourceAlpha = f32((source >>> 24) * f32((256 - destinationWeight) / 256));
  const destinationAlpha = f32(f32((destination >>> 24) / 256) * f32(256 - sourceAlpha));
  const alpha = f32(sourceAlpha + destinationAlpha);
  const reciprocal = aokanaRosettaSseReciprocal(alpha === 0 ? 1 : alpha);
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
export function aokanaAlphaTailPixel(
  source: number,
  destination: number,
  destinationWeight: number,
): number {
  const sourceAlpha = Math.imul(source >>> 24, 256 - destinationWeight) >>> 0;
  const destinationAlpha = Math.imul(destination >>> 24, 65536 - sourceAlpha) >>> 8;
  const denominator = (sourceAlpha + destinationAlpha) >>> 0;
  if (denominator === 0) throw new RangeError('Aokana bitmap native unsigned division by zero');
  return weightedRgb(
    source,
    destination,
    Math.trunc(((sourceAlpha << 8) >>> 0) / denominator),
    Math.trunc(((destinationAlpha << 8) >>> 0) / denominator),
    denominator >>> 8,
  );
}

/** 14003d690: normal format-2 over format-2, with native pair shortcuts and integer tail. */
export function blendAokanaAlpha(destination: AokanaBitmap, source: AokanaBitmap): void {
  visitAokanaPixelPairs(
    destination,
    source,
    (pixels, offset) => {
      if (pixels[0] >>> 24 === 0 && pixels[1] >>> 24 === 0) return;
      if (pixels[0] >>> 24 === 255 && pixels[1] >>> 24 === 255) {
        writeAokanaPixelPair(destination, offset, pixels);
        return;
      }
      const old = readAokanaPixelPair(destination, offset);
      writeAokanaPixelPair(destination, offset, [
        aokanaAlphaPairPixel(pixels[0], old[0], 0),
        aokanaAlphaPairPixel(pixels[1], old[1], 0),
      ]);
    },
    (pixel, offset) => {
      if (pixel >>> 24 === 0) return;
      bitmapWrite32(
        destination,
        offset,
        pixel >>> 24 === 255
          ? pixel
          : aokanaAlphaTailPixel(pixel, bitmapRead32(destination, offset), 0),
      );
    },
  );
}

/** 14003ca70: destinationWeight is native transparency, not source opacity. */
export function blendAokanaAlphaWithTransparency(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  destinationWeight: number,
): void {
  visitAokanaPixelPairs(
    destination,
    source,
    (pixels, offset) => {
      if (pixels[0] >>> 24 === 0 && pixels[1] >>> 24 === 0) return;
      const old = readAokanaPixelPair(destination, offset);
      writeAokanaPixelPair(destination, offset, [
        aokanaAlphaPairPixel(pixels[0], old[0], destinationWeight),
        aokanaAlphaPairPixel(pixels[1], old[1], destinationWeight),
      ]);
    },
    (pixel, offset) => {
      if (pixel >>> 24 !== 0)
        bitmapWrite32(
          destination,
          offset,
          aokanaAlphaTailPixel(pixel, bitmapRead32(destination, offset), destinationWeight),
        );
    },
  );
}

function rgbDifference(source: number, destination: number, weight: number): number {
  let pixel = destination & 0xff000000;
  for (let shift = 0; shift < 24; shift += 8) {
    const old = (destination >>> shift) & 255;
    const difference = ((source >>> shift) & 255) - old;
    pixel |= saturateAokanaByte(old + (aokanaSignedProduct16(difference, weight) >> 7)) << shift;
  }
  return pixel >>> 0;
}

/** 14003d950 has deliberately different alpha-byte handling in its opaque pair and tail. */
export function blendAokanaAlphaIntoRgb(destination: AokanaBitmap, source: AokanaBitmap): void {
  visitAokanaPixelPairs(
    destination,
    source,
    (pixels, offset) => {
      if (pixels[0] >>> 24 === 0 && pixels[1] >>> 24 === 0) return;
      if (pixels[0] >>> 24 >= 254 && pixels[1] >>> 24 >= 254) {
        writeAokanaPixelPair(destination, offset, pixels);
        return;
      }
      const old = readAokanaPixelPair(destination, offset);
      writeAokanaPixelPair(destination, offset, [
        rgbDifference(pixels[0], old[0], aokanaAlphaHalfCoefficient(pixels[0] >>> 24)),
        rgbDifference(pixels[1], old[1], aokanaAlphaHalfCoefficient(pixels[1] >>> 24)),
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
export function blendAokanaAlphaIntoRgbWithTransparency(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  transparency: number,
): void {
  const coefficient = (pixel: number): number => Math.imul(pixel >>> 25, 256 - transparency) >>> 8;
  visitAokanaPixelPairs(
    destination,
    source,
    (pixels, offset) => {
      if (pixels[0] >>> 24 === 0 && pixels[1] >>> 24 === 0) return;
      const old = readAokanaPixelPair(destination, offset);
      writeAokanaPixelPair(destination, offset, [
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
export function mixAokanaAllChannels(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  transparency: number,
): void {
  const coefficient = transparency >>> 1;
  const mix = (pixel: number, old: number): number => {
    let result = 0;
    for (let shift = 0; shift < 32; shift += 8) {
      const channel = (pixel >>> shift) & 255;
      const difference = ((old >>> shift) & 255) - channel;
      result |=
        saturateAokanaByte(channel + (aokanaSignedProduct16(difference, coefficient) >> 7)) <<
        shift;
    }
    return result >>> 0;
  };
  visitAokanaPixelPairs(
    destination,
    source,
    (pixels, offset) => {
      const old = readAokanaPixelPair(destination, offset);
      writeAokanaPixelPair(destination, offset, [mix(pixels[0], old[0]), mix(pixels[1], old[1])]);
    },
    (pixel, offset) =>
      bitmapWrite32(destination, offset, mix(pixel, bitmapRead32(destination, offset))),
  );
}

import {withBurikoBitmapText} from './bitmap-dom-text.js';
import type {BurikoBitmap} from './bitmap.js';
import {burikoAlphaPairPixel, burikoAlphaTailPixel} from './bitmap-alpha.js';
import {
  burikoAlphaHalfCoefficient,
  burikoSignedProduct16,
  readBurikoPixelPair,
  saturateBurikoByte,
  writeBurikoPixelPair,
} from './bitmap-pairs.js';
import {bitmapRead8, bitmapRead32, bitmapWrite32} from './bitmap-scalar.js';

function rgbMaskPixel(destination: number, color: number, coverage: number): number {
  const coefficient = burikoAlphaHalfCoefficient(coverage);
  if (coefficient === 0) return destination >>> 0;
  if (coefficient === 128) return color & 0xffffff;
  let output = 0;
  for (let shift = 0; shift < 32; shift += 8) {
    const previous = (destination >>> shift) & 255;
    const target = (color >>> shift) & 255;
    output |=
      saturateBurikoByte(previous + (burikoSignedProduct16(target - previous, coefficient) >> 7)) <<
      shift;
  }
  return output >>> 0;
}

/** 045600 blends format-three coverage into every byte of a format-one destination. */
function blendBurikoMaskColorIntoRgbPixels(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  color: number,
): void {
  color &= 0xffffff;
  const width = source.width >>> 0;
  for (let y = 0; y < source.height >>> 0; y++) {
    const input = source.offset + y * source.stride;
    const output = destination.offset + y * destination.stride;
    let x = 0;
    for (; x + 1 < width; x += 2) {
      const firstCoverage = bitmapRead8(source, input + x);
      const secondCoverage = bitmapRead8(source, input + x + 1);
      if (firstCoverage >>> 1 === 0 && secondCoverage >>> 1 === 0) continue;
      const pixels = readBurikoPixelPair(destination, output + x * 4);
      writeBurikoPixelPair(destination, output + x * 4, [
        rgbMaskPixel(pixels[0], color, firstCoverage),
        rgbMaskPixel(pixels[1], color, secondCoverage),
      ]);
    }
    if (x < width) {
      const coverage = bitmapRead8(source, input + x);
      if (coverage >>> 1 !== 0)
        bitmapWrite32(
          destination,
          output + x * 4,
          rgbMaskPixel(bitmapRead32(destination, output + x * 4), color, coverage),
        );
    }
  }
}

/** 045310 shares the RGBA pair reciprocal and scalar-tail arithmetic with ordinary alpha blend. */
function blendBurikoMaskColorIntoAlphaPixels(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  color: number,
): void {
  color &= 0xffffff;
  const width = source.width >>> 0;
  for (let y = 0; y < source.height >>> 0; y++) {
    const input = source.offset + y * source.stride;
    const output = destination.offset + y * destination.stride;
    let x = 0;
    for (; x + 1 < width; x += 2) {
      const firstCoverage = bitmapRead8(source, input + x);
      const secondCoverage = bitmapRead8(source, input + x + 1);
      if (firstCoverage === 0 && secondCoverage === 0) continue;
      if (firstCoverage === 255 && secondCoverage === 255) {
        const opaque = (color | 0xff000000) >>> 0;
        writeBurikoPixelPair(destination, output + x * 4, [opaque, opaque]);
        continue;
      }
      const pixels = readBurikoPixelPair(destination, output + x * 4);
      writeBurikoPixelPair(destination, output + x * 4, [
        burikoAlphaPairPixel((firstCoverage << 24) | color, pixels[0], 0),
        burikoAlphaPairPixel((secondCoverage << 24) | color, pixels[1], 0),
      ]);
    }
    if (x < width) {
      const coverage = bitmapRead8(source, input + x);
      if (coverage === 0) continue;
      const sourcePixel = ((coverage << 24) | color) >>> 0;
      bitmapWrite32(
        destination,
        output + x * 4,
        coverage === 255
          ? sourcePixel
          : burikoAlphaTailPixel(sourcePixel, bitmapRead32(destination, output + x * 4), 0),
      );
    }
  }
}

/** 045740 accepts only a format-three source and format-one/two destination. */
export function blendBurikoMaskColor(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  color: number,
): void {
  if (source.format !== 3) return;
  if (destination.format === 1) blendBurikoMaskColorIntoRgb(destination, source, color);
  else if (destination.format === 2) blendBurikoMaskColorIntoAlpha(destination, source, color);
}

export const blendBurikoMaskColorIntoRgb = withBurikoBitmapText(blendBurikoMaskColorIntoRgbPixels, {
  color: (_, args) => args[2] & 0xffffff,
});

export const blendBurikoMaskColorIntoAlpha = withBurikoBitmapText(
  blendBurikoMaskColorIntoAlphaPixels,
  {color: (_, args) => args[2] & 0xffffff},
);

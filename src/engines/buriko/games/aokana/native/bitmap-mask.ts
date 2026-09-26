import {withAokanaBitmapText} from './bitmap-dom-text.js';
import {bitmapStorage, type AokanaBitmap} from './bitmap.js';
import {bitmapRead8, bitmapRead16, bitmapRead32, bitmapWrite32} from './bitmap-scalar.js';
import {aokanaSignedProduct16, saturateAokanaByte} from './bitmap-pairs.js';

/** 04bdc0 loads the complete mask and source group before its one SIMD store. */
function copyGroup(
  destination: AokanaBitmap,
  destinationOffset: number,
  source: AokanaBitmap,
  sourceOffset: number,
  mask: number,
  count: 2 | 4,
): void {
  const input = bitmapStorage(source, sourceOffset, count * 4, true);
  const pixels = new Uint32Array(count);
  for (let lane = 0; lane < count; lane++)
    pixels[lane] = input.view.getUint32(sourceOffset + lane * 4, true);
  const output = bitmapStorage(destination, destinationOffset, count * 4, false);
  for (let lane = 0; lane < count; lane++)
    output.view.setUint32(
      destinationOffset + lane * 4,
      ((mask >>> (lane * 8)) & 255) === 0 ? 0 : pixels[lane]!,
      true,
    );
  output.written(destinationOffset, count * 4);
}

/** 04bef0 → 04bdc0: every nonzero mask byte copies the entire RGBA pixel; zero writes zero. */
function copyAokanaMaskedAlphaPixels(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  mask: AokanaBitmap,
): void {
  if (mask.format !== 3 || destination.format !== 2 || source.format !== 2) return;
  const width = Math.min(destination.width >>> 0, source.width >>> 0);
  const height = Math.min(destination.height >>> 0, source.height >>> 0);
  for (let y = 0; y < height; y++) {
    const destinationRow = destination.offset + y * (destination.stride | 0);
    const sourceRow = source.offset + y * (source.stride | 0);
    const maskRow = mask.offset + y * (mask.stride | 0);
    let x = 0;
    for (; x + 4 <= width; x += 4)
      copyGroup(
        destination,
        destinationRow + x * 4,
        source,
        sourceRow + x * 4,
        bitmapRead32(mask, maskRow + x),
        4,
      );
    if ((width & 2) !== 0) {
      copyGroup(
        destination,
        destinationRow + x * 4,
        source,
        sourceRow + x * 4,
        bitmapRead16(mask, maskRow + x),
        2,
      );
      x += 2;
    }
    if ((width & 1) !== 0) {
      const enabled = bitmapRead8(mask, maskRow + x) !== 0;
      const pixel = enabled ? bitmapRead32(source, sourceRow + x * 4) : 0;
      bitmapWrite32(destination, destinationRow + x * 4, pixel);
    }
  }
}

/** 04c340 → 04bf10: mask-gated RGB blend; the destination's fourth byte is retained. */
function blendAokanaMaskedAlphaIntoRgbPixels(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  mask: AokanaBitmap,
  transparency: number,
): void {
  transparency >>>= 0;
  if (mask.format !== 3 || destination.format !== 1 || source.format !== 2 || transparency >= 256)
    return;
  // The 128-entry SSE table has three equal RGB words and five zero words.
  const opacity = 256 - transparency;
  for (let y = 0; y < source.height >>> 0; y++) {
    const destinationRow = destination.offset + y * (destination.stride | 0);
    const sourceRow = source.offset + y * (source.stride | 0);
    const maskRow = mask.offset + y * (mask.stride | 0);
    for (let x = 0; x < source.width >>> 0; x++) {
      if (bitmapRead8(mask, maskRow + x) === 0) continue;
      const pixel = bitmapRead32(source, sourceRow + x * 4);
      if ((pixel & 0xfe000000) === 0) continue;
      const outputOffset = destinationRow + x * 4;
      const old = bitmapRead32(destination, outputOffset);
      const coefficient = Math.imul(pixel >>> 25, opacity) >>> 8;
      let result = old & 0xff000000;
      for (let shift = 0; shift < 24; shift += 8) {
        const before = (old >>> shift) & 255;
        const delta = ((pixel >>> shift) & 255) - before;
        result |=
          saturateAokanaByte(before + (aokanaSignedProduct16(delta, coefficient) >> 7)) << shift;
      }
      bitmapWrite32(destination, outputOffset, result);
    }
  }
}

export const copyAokanaMaskedAlpha = withAokanaBitmapText(copyAokanaMaskedAlphaPixels, {
  replace: true,
});

export const blendAokanaMaskedAlphaIntoRgb = withAokanaBitmapText(
  blendAokanaMaskedAlphaIntoRgbPixels,
  {opacity: (args) => (256 - args[3]) / 256},
);

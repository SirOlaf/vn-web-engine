import type {AokanaBitmap} from './bitmap.js';
import type {AokanaBitmapCompositor} from './bitmap-compositor.js';
import {clearAokanaBitmap} from './bitmap-copy.js';
import {bitmapRead8, bitmapRead32, bitmapWrite32} from './bitmap-scalar.js';

/** 04b070/04ae60 clamp the exponent, then apply a signed linear ramp to each mask byte. */
function reveal32(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  mask: AokanaBitmap,
  exponent: number,
  progress: number,
): void {
  const shift = Math.min(exponent >>> 0, 6),
    threshold = Math.imul((1 << shift) + 1, progress) | 0,
    width = source.width >>> 0,
    height = source.height >>> 0,
    alphaSource = source.format === 2;
  let outputRow = destination.offset,
    inputRow = source.offset,
    maskRow = mask.offset;
  for (let row = 0; row < height; row++) {
    let column = 0;
    for (; column + 3 < width; column += 4) {
      const colors: number[] = [],
        masks: number[] = [];
      const readColors = (): void => {
        for (let index = 0; index < 4; index++)
          colors.push(bitmapRead32(source, inputRow + (column + index) * 4));
      };
      const readMasks = (): void => {
        for (let index = 0; index < 4; index++)
          masks.push(bitmapRead8(mask, maskRow + column + index));
      };
      if (alphaSource) {
        readColors();
        readMasks();
      } else {
        readMasks();
        readColors();
      }
      for (let index = 0; index < 4; index++) {
        const pixel = colors[index]!,
          coverage = Math.max(0, Math.min(255, threshold - (masks[index]! << shift)));
        const alpha = alphaSource ? ((pixel >>> 24) * coverage) >>> 8 : coverage;
        bitmapWrite32(
          destination,
          outputRow + (column + index) * 4,
          (pixel & 0xffffff) | (alpha << 24),
        );
      }
    }
    for (; column < width; column++) {
      const coverage = Math.max(
          0,
          Math.min(255, (threshold - (bitmapRead8(mask, maskRow + column) << shift)) | 0),
        ),
        pixel = bitmapRead32(source, inputRow + column * 4);
      const alpha = alphaSource ? ((pixel >>> 24) * coverage) >>> 8 : coverage;
      bitmapWrite32(destination, outputRow + column * 4, (pixel & 0xffffff) | (alpha << 24));
    }
    outputRow += destination.stride | 0;
    inputRow += source.stride | 0;
    maskRow += mask.stride | 0;
  }
}

/** 04b230 returns the native fully-clear/fully-copied endpoints before source-format dispatch. */
export function revealAokanaBitmap(
  compositor: AokanaBitmapCompositor,
  destination: AokanaBitmap,
  source: AokanaBitmap,
  mask: AokanaBitmap,
  exponent: number,
  progress: number,
): void {
  if (mask.format !== 3 || destination.format !== 2) return;
  progress >>>= 0;
  if (progress === 0) {
    clearAokanaBitmap(destination);
    return;
  }
  if (progress >= 256) {
    compositor.copy(destination, source, 0);
    return;
  }
  if (source.format === 1 || source.format === 2)
    reveal32(destination, source, mask, exponent, progress);
}

/** 04b430/04b290 use their 129-entry signed high-word interpolation table. */
function blendReveal32(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  mask: AokanaBitmap,
  exponent: number,
  progress: number,
  transparency: number,
): void {
  const coefficients: number[] = [];
  let accumulator = 0;
  for (let index = 0; index < 129; index++) {
    coefficients.push((accumulator >>> 3) & 65535);
    accumulator = (accumulator + 256 - transparency) >>> 0;
  }
  const threshold = Math.imul(((1 << exponent) + 1) | 0, progress) | 0,
    width = source.width >>> 0,
    height = source.height >>> 0,
    alphaSource = source.format === 2;
  let outputRow = destination.offset,
    inputRow = source.offset,
    maskRow = mask.offset;
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const coverage = (threshold - (bitmapRead8(mask, maskRow + column) << exponent)) | 0;
      if (coverage <= 0) continue;
      let input: number, old: number, tableIndex: number;
      if (alphaSource) {
        input = bitmapRead32(source, inputRow + column * 4);
        if ((input & 0xfe000000) === 0) continue;
        old = bitmapRead32(destination, outputRow + column * 4);
        tableIndex = Math.imul(Math.min(256, coverage), input >>> 24) >>> 9;
      } else {
        old = bitmapRead32(destination, outputRow + column * 4);
        input = bitmapRead32(source, inputRow + column * 4);
        tableIndex = coverage >= 256 ? 128 : coverage >> 1;
      }
      const coefficient = (coefficients[tableIndex]! << 16) >> 16;
      let result = old & 0xff000000;
      for (let shift = 0; shift < 24; shift += 8) {
        const value = (old >>> shift) & 255,
          delta = (((input >>> shift) & 255) - value) << 4;
        result |=
          Math.max(0, Math.min(255, value + Math.floor((delta * coefficient) / 65536))) << shift;
      }
      bitmapWrite32(destination, outputRow + column * 4, result);
    }
    outputRow += destination.stride | 0;
    inputRow += source.stride | 0;
    maskRow += mask.stride | 0;
  }
}

/** 04b5c0 blends the reveal directly into RGB, retaining the separate ordinary blend endpoint. */
export function blendRevealedAokanaBitmap(
  compositor: AokanaBitmapCompositor,
  destination: AokanaBitmap,
  source: AokanaBitmap,
  mask: AokanaBitmap,
  exponent: number,
  progress: number,
  transparency: number,
): void {
  if (mask.format !== 3 || destination.format !== 1 || transparency >>> 0 >= 256) return;
  if (progress >>> 0 >= 256) {
    compositor.composite(destination, source, 0x20, transparency, false);
    return;
  }
  if (source.format === 1 || source.format === 2)
    blendReveal32(destination, source, mask, exponent, progress, transparency);
}

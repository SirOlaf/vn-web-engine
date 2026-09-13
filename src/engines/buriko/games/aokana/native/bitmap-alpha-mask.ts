import type {AokanaBitmap} from './bitmap.js';
import {bitmapRead8, bitmapRead32, bitmapWrite8, bitmapWrite32} from './bitmap-scalar.js';

type MaskStatus = 0 | 7 | 9 | 10;

/** The three-descriptor kernels retain their native source/mask-first extent selection. */
function extent(destination: number, source: number, mask: number): number {
  return source >>> 0 > mask >>> 0 ? mask >>> 0 : Math.min(destination >>> 0, source >>> 0);
}

function samePixels(first: AokanaBitmap, second: AokanaBitmap): boolean {
  if (first.storage === null || second.storage === null)
    return first.storage === second.storage && first.offset === second.offset;
  return (
    first.storage.bytes.buffer === second.storage.bytes.buffer &&
    first.storage.bytes.byteOffset + first.offset ===
      second.storage.bytes.byteOffset + second.offset
  );
}

/** 04c370/04c510/04c680 and 04d110/04cf50 read each 4/2/1-pixel group before its stores. */
function mask32(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  mask: AokanaBitmap,
  coefficient: number,
  byteMask: boolean,
  inPlace: boolean,
): void {
  const input = inPlace ? destination : source;
  const width = inPlace
      ? Math.min(destination.width >>> 0, mask.width >>> 0)
      : extent(destination.width, source.width, mask.width),
    height = inPlace
      ? Math.min(destination.height >>> 0, mask.height >>> 0)
      : extent(destination.height, source.height, mask.height);
  const alphaSource = source.format >>> 0 === 2;
  let outputRow = destination.offset,
    inputRow = input.offset,
    maskRow = mask.offset;
  for (let row = 0; row < height; row++) {
    let column = 0;
    const group = (count: 1 | 2 | 4): void => {
      const sourcePixels: number[] = [],
        maskValues: number[] = [];
      const readSource = (): void => {
        for (let index = 0; index < count; index++)
          sourcePixels.push(bitmapRead32(input, inputRow + (column + index) * 4));
      };
      const readMask = (): void => {
        for (let index = 0; index < count; index++) {
          const offset = maskRow + (column + index) * (byteMask ? 1 : 4);
          maskValues.push(byteMask ? bitmapRead8(mask, offset) : bitmapRead32(mask, offset) >>> 24);
        }
      };
      if (alphaSource) {
        readSource();
        readMask();
      } else {
        readMask();
        readSource();
      }
      for (let index = 0; index < count; index++) {
        const pixel = sourcePixels[index]!,
          maskValue = maskValues[index]!;
        let alpha: number;
        if (byteMask) alpha = alphaSource ? ((pixel >>> 24) * maskValue) >>> 8 : maskValue;
        else if (!alphaSource) alpha = (Math.imul(maskValue, coefficient) >>> 8) & 255;
        else if (count === 1)
          // The scalar tail retains the full DWORD product; SIMD first truncates PMULLW.
          alpha = (Math.imul(Math.imul(pixel >>> 24, maskValue), coefficient) >>> 16) & 255;
        else alpha = ((pixel >>> 24) * (Math.imul(maskValue, coefficient) & 65535)) >>> 16;
        bitmapWrite32(
          destination,
          outputRow + (column + index) * 4,
          (pixel & 0xffffff) | (alpha << 24),
        );
      }
      column += count;
    };
    for (let count = width >>> 2; count !== 0; count--) group(4);
    if ((width & 2) !== 0) group(2);
    if ((width & 1) !== 0) group(1);
    outputRow += destination.stride | 0;
    inputRow += input.stride | 0;
    maskRow += mask.stride | 0;
  }
}

/** 04e5d0 supplies 256-transparency to both the separate and same-pointer RGBA paths. */
export function applyAokanaAlphaMask(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  mask: AokanaBitmap,
  transparency: number,
): MaskStatus {
  const coefficient = (256 - transparency) | 0;
  if (destination.format >>> 0 !== 2) return 10;
  if (source.format >>> 0 !== 1 && source.format >>> 0 !== 2) return 9;
  if (mask.format >>> 0 !== 2) return 7;
  mask32(
    destination,
    source,
    mask,
    coefficient,
    false,
    source.format === 2 && samePixels(destination, source),
  );
  return 0;
}

/** 04d280 traverses one-byte rows backwards and uses mask+1 in its /256 product. */
function mask8(destination: AokanaBitmap, source: AokanaBitmap, mask: AokanaBitmap): void {
  const width = Math.min(source.width >>> 0, mask.width >>> 0),
    height = Math.min(source.height >>> 0, mask.height >>> 0);
  let outputRow = destination.offset,
    inputRow = source.offset,
    maskRow = mask.offset;
  for (let row = 0; row < height; row++) {
    for (let column = width - 1; column >= 0; column--) {
      const pixel = bitmapRead8(source, inputRow + column);
      let value = 0;
      if (pixel !== 0) {
        const maskValue = bitmapRead8(mask, maskRow + column);
        if (maskValue !== 0) value = (pixel * (maskValue + 1)) >>> 8;
      }
      bitmapWrite8(destination, outputRow + column, value);
    }
    outputRow += destination.stride | 0;
    inputRow += source.stride | 0;
    maskRow += mask.stride | 0;
  }
}

/** 04e670 selects the concrete RGBA-mask or one-byte-mask operation by descriptor format. */
export function applyAokanaBitmapMask(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  mask: AokanaBitmap,
): MaskStatus {
  if (mask.format >>> 0 === 2) return applyAokanaAlphaMask(destination, source, mask, 0);
  if (mask.format >>> 0 !== 3) return 7;
  if (destination.format >>> 0 === 2) {
    if (source.format >>> 0 !== 1 && source.format >>> 0 !== 2) return 9;
    mask32(destination, source, mask, 256, true, false);
    return 0;
  }
  if (destination.format >>> 0 !== 3) return 10;
  if (source.format >>> 0 !== 3) return 9;
  mask8(destination, source, mask);
  return 0;
}

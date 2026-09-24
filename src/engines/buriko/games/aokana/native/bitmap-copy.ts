import {
  bitmapStorage,
  cropAokanaBitmap,
  type AokanaBitmap,
  type AokanaBitmapRectangle,
} from './bitmap.js';
import {bitmapRead8, bitmapRead32, bitmapWrite8, bitmapWrite32} from './bitmap-scalar.js';
import {aokanaAlphaHalfCoefficient, writeAokanaMappedPairs} from './bitmap-pairs.js';

/** 140041310 ignores unsuccessful rectangle cropping and then clears the original descriptor. */
export function clearAokanaBitmap(
  bitmap: AokanaBitmap,
  rectangle: AokanaBitmapRectangle | null = null,
): void {
  const target = {...bitmap};
  if (rectangle !== null) cropAokanaBitmap(target, rectangle);
  const rowBytes = Math.imul(target.bytesPerPixel, target.width) >>> 0;
  for (let y = 0; y < target.height >>> 0; y++) {
    if (rowBytes === 0) continue;
    const offset = target.offset + y * target.stride;
    const storage = bitmapStorage(target, offset, rowBytes, false);
    storage.bytes.fill(0, offset, offset + rowBytes);
    storage.written(offset, rowBytes);
  }
}

export function copyBlock(
  destination: AokanaBitmap,
  destinationOffset: number,
  source: AokanaBitmap,
  sourceOffset: number,
  length: number,
): void {
  const input = bitmapStorage(source, sourceOffset, length, true).bytes.slice(
    sourceOffset,
    sourceOffset + length,
  );
  const output = bitmapStorage(destination, destinationOffset, length, false);
  output.bytes.set(input, destinationOffset);
  output.written(destinationOffset, length);
}

/**
 * 1400410c0/14003dd70 copy aligned 16-byte blocks, otherwise successive 8-byte blocks.
 * Only row lengths that are not divisible by four use the native overlap-safe memmove.
 */
export function copyAokanaBitmapRows(destination: AokanaBitmap, source: AokanaBitmap): void {
  const rowBytes = Math.imul(source.bytesPerPixel, source.width) >>> 0;
  const aligned =
    ((source.offset | destination.offset | source.stride | destination.stride) & 15) === 0;
  const block = (rowBytes & 15) === 0 && aligned ? 16 : 8;
  for (let y = 0; y < source.height >>> 0; y++) {
    const input = source.offset + y * source.stride;
    const output = destination.offset + y * destination.stride;
    if ((rowBytes & 3) !== 0) {
      copyBlock(destination, output, source, input, rowBytes);
      continue;
    }
    let byte = 0;
    for (; byte + block <= rowBytes; byte += block)
      copyBlock(destination, output + byte, source, input + byte, block);
    if (byte < rowBytes) copyBlock(destination, output + byte, source, input + byte, 4);
  }
}

/** 14003dcc0 preserves source RGB and forces both pair and tail alpha bytes to 255. */
export function copyAokanaRgbToAlpha(destination: AokanaBitmap, source: AokanaBitmap): void {
  writeAokanaMappedPairs(destination, source, (pixel) => pixel | 0xff000000);
}

/** 14003dbb0 uses the native alpha/2 table, whose last entry promotes 254 to opaque. */
export function copyAokanaAlphaToRgb(destination: AokanaBitmap, source: AokanaBitmap): void {
  writeAokanaMappedPairs(destination, source, (pixel) => {
    const coefficient = aokanaAlphaHalfCoefficient(pixel >>> 24);
    let result = 0;
    for (let shift = 0; shift < 24; shift += 8)
      result |= ((Math.imul((pixel >>> shift) & 255, coefficient) & 65535) >>> 7) << shift;
    return result >>> 0;
  });
}

/** 140046620 expands four mask bytes from one source DWORD before storing sixteen bytes. */
export function copyAokanaMaskToAlpha(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  color: number,
): void {
  const width = Math.min(destination.width >>> 0, source.width >>> 0);
  const height = Math.min(destination.height >>> 0, source.height >>> 0);
  color &= 0xffffff;
  for (let y = 0; y < height; y++) {
    const input = source.offset + y * source.stride;
    const output = destination.offset + y * destination.stride;
    let x = 0;
    for (; x + 3 < width; x += 4) {
      const mask = bitmapRead32(source, input + x);
      for (let channel = 0; channel < 4; channel++)
        bitmapWrite32(
          destination,
          output + (x + channel) * 4,
          ((mask >>> (channel * 8)) << 24) | color,
        );
    }
    for (; x < width; x++)
      bitmapWrite32(destination, output + x * 4, (bitmapRead8(source, input + x) << 24) | color);
  }
}

/** 14003d270 retains scalar read/store order when source and destination alias. */
export function blendAokanaRgbIntoAlphaWithTransparency(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  transparency: number,
): void {
  const sourceAlpha = Math.imul(256 - transparency, 255) >>> 0;
  const sourceNumerator = (sourceAlpha << 16) >>> 0;
  const destinationFactor = (65536 - sourceAlpha) >>> 0;
  for (let y = 0; y < source.height >>> 0; y++)
    for (let x = 0; x < source.width >>> 0; x++) {
      const input = source.offset + y * source.stride + x * 4;
      const output = destination.offset + y * destination.stride + x * 4;
      const destinationAlpha =
        Math.imul(bitmapRead8(destination, output + 3), destinationFactor) >>> 8;
      const denominator = (sourceAlpha + destinationAlpha) >>> 0;
      if (denominator === 0) throw new RangeError('Aokana bitmap native unsigned division by zero');
      const sourceCoefficient = Math.trunc(sourceNumerator / denominator);
      const destinationCoefficient = Math.trunc(((destinationAlpha << 16) >>> 0) / denominator);
      const sourceBlue = Math.imul(bitmapRead8(source, input), sourceCoefficient);
      const destinationBlue = Math.imul(bitmapRead8(destination, output), destinationCoefficient);
      const destinationGreen = Math.imul(
        bitmapRead8(destination, output + 1),
        destinationCoefficient,
      );
      bitmapWrite8(destination, output, (sourceBlue + destinationBlue) >>> 16);
      const sourceGreen = Math.imul(bitmapRead8(source, input + 1), sourceCoefficient);
      const destinationRed = Math.imul(
        bitmapRead8(destination, output + 2),
        destinationCoefficient,
      );
      bitmapWrite8(destination, output + 1, (sourceGreen + destinationGreen) >>> 16);
      const sourceRed = Math.imul(bitmapRead8(source, input + 2), sourceCoefficient);
      bitmapWrite8(destination, output + 3, denominator >>> 8);
      bitmapWrite8(destination, output + 2, (sourceRed + destinationRed) >>> 16);
    }
}

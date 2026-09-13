import {bitmapStorage, type AokanaBitmap} from './bitmap.js';
import {bitmapRead32, bitmapWrite32} from './bitmap-scalar.js';

export type AokanaPixelPair = readonly [number, number];

/** A MOVQ reads both source pixels before an overlapping destination can change either. */
export function readAokanaPixelPair(bitmap: AokanaBitmap, offset: number): AokanaPixelPair {
  const view = bitmapStorage(bitmap, offset, 8, true).view;
  return [view.getUint32(offset, true), view.getUint32(offset + 4, true)];
}

export function writeAokanaPixelPair(
  bitmap: AokanaBitmap,
  offset: number,
  pixels: AokanaPixelPair,
): void {
  const storage = bitmapStorage(bitmap, offset, 8, false);
  storage.view.setUint32(offset, pixels[0], true);
  storage.view.setUint32(offset + 4, pixels[1], true);
  storage.written(offset, 8);
}

/** Row traversal shared by native MOVQ pairs followed by one optional MOVD. */
export function visitAokanaPixelPairs(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  pair: (source: AokanaPixelPair, destinationOffset: number) => void,
  tail: (source: number, destinationOffset: number) => void,
): void {
  const width = source.width >>> 0;
  for (let y = 0; y < source.height >>> 0; y++) {
    const sourceRow = source.offset + y * source.stride;
    const destinationRow = destination.offset + y * destination.stride;
    let x = 0;
    for (; x + 1 < width; x += 2)
      pair(readAokanaPixelPair(source, sourceRow + x * 4), destinationRow + x * 4);
    if (x < width) tail(bitmapRead32(source, sourceRow + x * 4), destinationRow + x * 4);
  }
}

export function saturateAokanaByte(value: number): number {
  return Math.min(255, Math.max(0, value));
}

export function aokanaSignedProduct16(a: number, b: number): number {
  return (Math.imul(a, b) << 16) >> 16;
}

/** 1400408c0 deliberately replaces the penultimate alpha/2 table entry with 128. */
export function aokanaAlphaHalfCoefficient(alpha: number): number {
  return alpha >= 254 ? 128 : alpha >>> 1;
}

export function writeAokanaMappedPairs(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  pixel: (source: number) => number,
): void {
  visitAokanaPixelPairs(
    destination,
    source,
    (pixels, offset) =>
      writeAokanaPixelPair(destination, offset, [pixel(pixels[0]), pixel(pixels[1])]),
    (value, offset) => bitmapWrite32(destination, offset, pixel(value)),
  );
}

import {bitmapStorage, type BurikoBitmap} from './bitmap.js';
import {bitmapRead32, bitmapWrite32} from './bitmap-scalar.js';

export type BurikoPixelPair = readonly [number, number];

/** A MOVQ reads both source pixels before an overlapping destination can change either. */
export function readBurikoPixelPair(bitmap: BurikoBitmap, offset: number): BurikoPixelPair {
  const view = bitmapStorage(bitmap, offset, 8, true).view;
  return [view.getUint32(offset, true), view.getUint32(offset + 4, true)];
}

export function readBurikoPixelPairInto(
  bitmap: BurikoBitmap,
  offset: number,
  pixels: [number, number],
): void {
  const view = bitmapStorage(bitmap, offset, 8, true).view;
  pixels[0] = view.getUint32(offset, true);
  pixels[1] = view.getUint32(offset + 4, true);
}

export function writeBurikoPixelPair(
  bitmap: BurikoBitmap,
  offset: number,
  pixels: BurikoPixelPair,
): void {
  writeBurikoPixelPairValues(bitmap, offset, pixels[0], pixels[1]);
}

/** Internal scalar-store form for hot loops that already hold both pixel values. */
export function writeBurikoPixelPairValues(
  bitmap: BurikoBitmap,
  offset: number,
  first: number,
  second: number,
): void {
  const storage = bitmapStorage(bitmap, offset, 8, false);
  storage.view.setUint32(offset, first, true);
  storage.view.setUint32(offset + 4, second, true);
  storage.written(offset, 8);
}

/** Row traversal shared by native MOVQ pairs followed by one optional MOVD. */
function visitPixelPairs(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  pair: (source: BurikoPixelPair, destinationOffset: number) => void,
  tail: (source: number, destinationOffset: number) => void,
  reuseSourcePair: boolean,
): void {
  const width = source.width >>> 0;
  // The native MOVQ loads both pixels before invoking the operation. Reuse one
  // scratch pair per traversal to avoid allocating a tuple for every pair.
  const pixels: [number, number] = [0, 0];
  for (let y = 0; y < source.height >>> 0; y++) {
    const sourceRow = source.offset + y * source.stride;
    const destinationRow = destination.offset + y * destination.stride;
    let x = 0;
    for (; x + 1 < width; x += 2) {
      if (reuseSourcePair) {
        readBurikoPixelPairInto(source, sourceRow + x * 4, pixels);
        pair(pixels, destinationRow + x * 4);
      } else pair(readBurikoPixelPair(source, sourceRow + x * 4), destinationRow + x * 4);
    }
    if (x < width) tail(bitmapRead32(source, sourceRow + x * 4), destinationRow + x * 4);
  }
}

/** Row traversal shared by native MOVQ pairs followed by one optional MOVD. */
export function visitBurikoPixelPairs(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  pair: (source: BurikoPixelPair, destinationOffset: number) => void,
  tail: (source: number, destinationOffset: number) => void,
): void {
  visitPixelPairs(destination, source, pair, tail, false);
}

/** Internal hot path for synchronous operations whose pair callback does not retain source. */
export function visitBurikoPixelPairsReusingSource(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  pair: (source: BurikoPixelPair, destinationOffset: number) => void,
  tail: (source: number, destinationOffset: number) => void,
): void {
  visitPixelPairs(destination, source, pair, tail, true);
}

export function saturateBurikoByte(value: number): number {
  return Math.min(255, Math.max(0, value));
}

export function burikoSignedProduct16(a: number, b: number): number {
  return (Math.imul(a, b) << 16) >> 16;
}

/** 1400408c0 deliberately replaces the penultimate alpha/2 table entry with 128. */
export function burikoAlphaHalfCoefficient(alpha: number): number {
  return alpha >= 254 ? 128 : alpha >>> 1;
}

export function writeBurikoMappedPairs(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  pixel: (source: number) => number,
): void {
  visitBurikoPixelPairs(
    destination,
    source,
    (pixels, offset) =>
      writeBurikoPixelPair(destination, offset, [pixel(pixels[0]), pixel(pixels[1])]),
    (value, offset) => bitmapWrite32(destination, offset, pixel(value)),
  );
}

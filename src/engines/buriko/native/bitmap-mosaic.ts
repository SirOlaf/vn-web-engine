import {withBurikoBitmapText} from './bitmap-dom-text.js';
import type {BurikoBitmap} from './bitmap.js';
import type {BurikoBitmapCompositor} from './bitmap-compositor.js';
import {bitmapRead32, bitmapWrite32} from './bitmap-scalar.js';
import {readBurikoPixelPair, writeBurikoPixelPair, saturateBurikoByte} from './bitmap-pairs.js';

type Lanes = [number, number, number, number];
const signed16 = (value: number): number => (value << 16) >> 16;
const saturate16 = (value: number): number => Math.min(32767, Math.max(-32768, value | 0));
const channels = (pixel: number): Lanes => [
  pixel & 255,
  (pixel >>> 8) & 255,
  (pixel >>> 16) & 255,
  pixel >>> 24,
];
const reciprocal = (length: number, side: number): number =>
  length !== side && length === 1 ? 65535 : (Math.floor(65536 / length) + 1) & 65535;
const normalize = (sum: number, coefficient: number): number =>
  ((Math.imul(sum & 65535, coefficient) + coefficient + 1) >>> 0) >>> 16;

/** 046E40/0469D0: PADDW rows, reciprocal/bias normalization, PADDD then PACKSSDW. */
function average(
  source: BurikoBitmap,
  start: number,
  width: number,
  height: number,
  side: number,
): Lanes {
  const horizontal = reciprocal(width, side),
    vertical = reciprocal(height, side);
  const sums: Lanes = [0, 0, 0, 0];
  for (let y = 0; y < height; y++) {
    const row: Lanes = [0, 0, 0, 0];
    const add = (pixel: number): void => {
      const values = channels(pixel);
      for (let lane = 0; lane < 4; lane++) row[lane] = (row[lane]! + values[lane]!) & 65535;
    };
    let x = 0;
    const offset = start + y * ((source.stride >> 2) * 4);
    for (; x + 1 < width; x += 2) {
      const pair = readBurikoPixelPair(source, offset + x * 4);
      add(pair[0]);
      add(pair[1]);
    }
    if (x < width) add(bitmapRead32(source, offset + x * 4));
    for (let lane = 0; lane < 4; lane++)
      sums[lane] = (sums[lane]! + normalize(row[lane]!, horizontal)) | 0;
  }
  return sums.map((sum) => saturate16(normalize(saturate16(sum), vertical))) as Lanes;
}

function packed(lanes: Lanes): number {
  return (
    (saturateBurikoByte(lanes[0]) |
      (saturateBurikoByte(lanes[1]) << 8) |
      (saturateBurikoByte(lanes[2]) << 16) |
      (saturateBurikoByte(lanes[3]) << 24)) >>>
    0
  );
}
function mixed(old: number, lanes: Lanes, transparency: number): number {
  const values = channels(old),
    coefficient = signed16(transparency << 4);
  return packed(
    values.map((value, index) => {
      const source = lanes[index]!;
      const difference = signed16((value - source) << 4);
      return signed16((Math.imul(difference, coefficient) >> 16) + source);
    }) as Lanes,
  );
}

/** Exact block traversal shared by047470/047270/046E40/0469D0. */
function mosaicBlocks(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  level: number,
  averaged: boolean,
  transparency: number,
): void {
  const side = (level + 1) >>> 0;
  const width = Math.min(destination.width >>> 0, source.width >>> 0);
  const height = Math.min(destination.height >>> 0, source.height >>> 0);
  if (side === 0 && (averaged || height !== 0))
    throw new RangeError('Buriko mosaic has a zero native block divisor/step');
  const destinationStep = (Math.imul(destination.stride >> 2, side) >>> 0) * 4;
  const sourceStep = (Math.imul(source.stride >> 2, side) >>> 0) * 4;
  let sourceRow = source.offset,
    destinationRow = destination.offset;
  for (let remainingY = height; remainingY !== 0;) {
    const blockHeight = Math.min(remainingY, side);
    let sourceBlock = sourceRow,
      destinationBlock = destinationRow;
    for (let remainingX = width; remainingX !== 0;) {
      const blockWidth = Math.min(remainingX, side);
      // Capture the whole block average (or one top-left DWORD) before any writes.
      const lanes = averaged
        ? average(source, sourceBlock, blockWidth, blockHeight, side)
        : channels(bitmapRead32(source, sourceBlock));
      const pixel = packed(lanes);
      for (let y = 0; y < blockHeight; y++) {
        const offset = destinationBlock + y * ((destination.stride >> 2) * 4);
        if (transparency === 0) {
          for (let x = 0; x < blockWidth; x++) bitmapWrite32(destination, offset + x * 4, pixel);
        } else {
          let x = 0;
          for (; x + 1 < blockWidth; x += 2) {
            const pair = readBurikoPixelPair(destination, offset + x * 4);
            writeBurikoPixelPair(destination, offset + x * 4, [
              mixed(pair[0], lanes, transparency),
              mixed(pair[1], lanes, transparency),
            ]);
          }
          if (x < blockWidth)
            bitmapWrite32(
              destination,
              offset + x * 4,
              mixed(bitmapRead32(destination, offset + x * 4), lanes, transparency),
            );
        }
      }
      sourceBlock += side * 4;
      destinationBlock += side * 4;
      remainingX -= blockWidth;
    }
    sourceRow += sourceStep;
    destinationRow += destinationStep;
    remainingY -= blockHeight;
  }
}

/** 047630 routes four real mosaic kernels or03D610 at level0. */
function mosaicBurikoBitmapPixels(
  compositor: BurikoBitmapCompositor,
  destination: BurikoBitmap,
  source: BurikoBitmap,
  level: number,
  selector: number,
  transparency: number,
): 0 | 1 | 0x18 {
  level >>>= 0;
  selector >>>= 0;
  transparency >>>= 0;
  if (destination.format !== source.format) return 1;
  if (source.format !== 1 && source.format !== 2) return 0;
  if (level === 0) {
    compositor.composite(destination, source, 1, transparency);
    return 0;
  }
  if (selector !== 0 && selector !== 1) return 0x18;
  if (transparency < 256) mosaicBlocks(destination, source, level, selector === 1, transparency);
  return 0;
}

export const mosaicBurikoBitmap = withBurikoBitmapText(mosaicBurikoBitmapPixels, {
  destination: 1,
  source: 2,
  opacity: (args) => (256 - args[5]) / 256,
  applied: (result, args) =>
    result === 0 && (args[2].format === 1 || args[2].format === 2) && args[5] < 256,
});

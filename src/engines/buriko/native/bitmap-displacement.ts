import {withBurikoBitmapText} from './bitmap-dom-text.js';
import type {BurikoBitmap} from './bitmap.js';
import type {BurikoBitmapCompositor} from './bitmap-compositor.js';
import {bitmapRead16, bitmapRead32, bitmapWrite32} from './bitmap-scalar.js';

function signedWord(value: number): number {
  return (value << 16) >> 16;
}

/** Both native kernels derive the full-image bounds relative to the cropped source pointer. */
function relativeOrigin(source: BurikoBitmap, bounds: BurikoBitmap): [number, number] {
  if (
    source.storage === null ||
    bounds.storage === null ||
    source.storage.bytes.buffer !== bounds.storage.bytes.buffer
  )
    throw new Error('Buriko displacement requires cropped and full descriptors of the same bitmap');
  const stride = source.stride | 0;
  if (stride === 0)
    throw new RangeError('Buriko displacement requires a nonzero source row stride');
  const difference =
    BigInt(bounds.storage.bytes.byteOffset + bounds.offset) -
    BigInt(source.storage.bytes.byteOffset + source.offset);
  const quotient = difference / BigInt(stride),
    y = Number(BigInt.asIntN(32, quotient));
  const x = (difference - BigInt(Math.imul(stride, y))) >> 2n;
  return [Number(BigInt.asIntN(32, x)), y];
}

interface DisplacementPoint {
  x: number;
  y: number;
  fractionX: number;
  fractionY: number;
}

/** Signed WORD products supply rounded nearest coordinates or unrounded Q4 bilinear parts. */
function point(
  map: BurikoBitmap,
  offset: number,
  column: number,
  row: number,
  table: Uint32Array,
  bilinear: boolean,
): DisplacementPoint {
  const displacement = bitmapRead32(map, offset),
    index = bitmapRead16(map, offset + 4),
    coefficients = table[index];
  if (coefficients === undefined)
    throw new RangeError('Buriko displacement table lacks the requested coefficient');
  const productX = signedWord(displacement) * signedWord(coefficients),
    productY = signedWord(displacement >>> 16) * signedWord(coefficients >>> 16);
  const nearestX = bilinear ? 0 : (productX >>> 15) & 1,
    nearestY = bilinear ? 0 : (productY >>> 15) & 1;
  return {
    x: signedWord((productX >> 16) + nearestX + column),
    y: signedWord((productY >> 16) + nearestY + row),
    fractionX: (productX >>> 12) & 15,
    fractionY: (productY >>> 12) & 15,
  };
}

/** 0476e0/047b70 preserve rectangular WORD checks or the native linear DWORD span checks. */
function displace32(
  compositor: BurikoBitmapCompositor,
  destination: BurikoBitmap,
  source: BurikoBitmap,
  bounds: BurikoBitmap,
  map: BurikoBitmap,
  table: Uint32Array,
  bilinear: boolean,
): void {
  const [originX, originY] = relativeOrigin(source, bounds),
    pitch = source.stride >> 2,
    wordPitch = signedWord(pitch);
  const rectangle = compositor.filterProperty === 1;
  const left = signedWord(originX),
    top = signedWord(originY),
    right = signedWord(originX + bounds.width),
    bottom = signedWord(originY + bounds.height);
  const firstIndex = (Math.imul(originY, pitch) + originX) | 0,
    endIndex = (firstIndex + Math.imul(bounds.height, pitch)) | 0;
  const width = Math.min(destination.width >>> 0, map.width >>> 0),
    height = Math.min(destination.height >>> 0, map.height >>> 0);
  const read = (x: number, y: number, index: number, byteOffset = index * 4): number => {
    const inside = rectangle
      ? x >= left && x < right && y >= top && y < bottom
      : index >= firstIndex && index < endIndex;
    return inside ? bitmapRead32(source, source.offset + byteOffset) : 0;
  };
  const sample = (coordinate: DisplacementPoint): number => {
    const {x, y, fractionX, fractionY} = coordinate,
      index = (x + Math.imul(y, wordPitch)) | 0,
      first = read(x, y, index);
    if (!bilinear) return first;
    const nextX = signedWord(x + 1),
      nextY = signedWord(y + 1),
      rightIndex = (index + 1) | 0,
      bottomIndex = (index + pitch) | 0;
    const second = read(nextX, y, rightIndex),
      third = read(x, nextY, bottomIndex),
      fourth = read(nextX, nextY, (index + pitch + 1) | 0, bottomIndex * 4 + 4);
    let result = 0;
    for (let shift = 0; shift < 32; shift += 8) {
      const firstValue = (first >>> shift) & 255,
        thirdValue = (third >>> shift) & 255,
        upper = firstValue + (((((second >>> shift) & 255) - firstValue) * fractionX) >> 4),
        lower = thirdValue + (((((fourth >>> shift) & 255) - thirdValue) * fractionX) >> 4);
      result |= (upper + (((lower - upper) * fractionY) >> 4)) << shift;
    }
    return result >>> 0;
  };
  let outputRow = destination.offset,
    mapRow = map.offset;
  for (let row = 0; row < height; row++) {
    let column = 0;
    for (; column + 1 < width; column += 2) {
      const firstPoint = point(map, mapRow + column * 6, column, row, table, bilinear),
        secondPoint = point(map, mapRow + column * 6 + 6, column + 1, row, table, bilinear),
        first = sample(firstPoint),
        second = sample(secondPoint);
      bitmapWrite32(destination, outputRow + column * 4, first);
      bitmapWrite32(destination, outputRow + column * 4 + 4, second);
    }
    if ((width & 1) !== 0)
      bitmapWrite32(
        destination,
        outputRow + column * 4,
        sample(point(map, mapRow + column * 6, column, row, table, bilinear)),
      );
    outputRow += destination.stride | 0;
    mapRow += map.stride | 0;
  }
}

/** 048640 requires a format-six map matching the output dimensions before format dispatch. */
function displaceBurikoBitmapPixels(
  compositor: BurikoBitmapCompositor,
  destination: BurikoBitmap,
  source: BurikoBitmap,
  fullSource: BurikoBitmap,
  map: BurikoBitmap,
  table: Uint32Array,
  bilinear: number,
): 0 | 1 | 0xc {
  if (map.format !== 6 || destination.width !== map.width || destination.height !== map.height)
    return 0xc;
  if (destination.format !== source.format) return 1;
  if (source.format === 1 || source.format === 2)
    displace32(compositor, destination, source, fullSource, map, table, (bilinear | 0) !== 0);
  return 0;
}

export const displaceBurikoBitmap = withBurikoBitmapText(displaceBurikoBitmapPixels, {
  destination: 1,
  source: 2,
  replace: true,
  applied: (result, args) => result === 0 && (args[2].format === 1 || args[2].format === 2),
  // Invert the local warp at glyph corners; DOM retains a readable box through nonlinear effects.
  map: (x, y, args) => {
    const map = args[4],
      table = args[5];
    if (map.width <= 0 || map.height <= 0) return [NaN, NaN];
    let outputX = x,
      outputY = y;
    for (let iteration = 0; iteration < 4; iteration++) {
      const column = Math.max(0, Math.min(map.width - 1, Math.floor(outputX))),
        row = Math.max(0, Math.min(map.height - 1, Math.floor(outputY))),
        sample = point(
          map,
          map.offset + row * map.stride + column * 6,
          column,
          row,
          table,
          args[6] !== 0,
        );
      outputX = x - (sample.x + sample.fractionX / 16 - column);
      outputY = y - (sample.y + sample.fractionY / 16 - row);
    }
    return [outputX, outputY];
  },
});

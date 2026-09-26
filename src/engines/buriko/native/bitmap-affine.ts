import {withBurikoBitmapText} from './bitmap-dom-text.js';
import {nativeAffineSineCosine} from '../bp/opcodes/native-math.js';
import {
  burikoBitmapRectangle,
  cropBurikoBitmap,
  intersectBurikoBitmapRectangle,
  translateBurikoBitmapRectangle,
  type BurikoBitmap,
} from './bitmap.js';
import type {BurikoBitmapCompositor} from './bitmap-compositor.js';
import {clearBurikoBitmap} from './bitmap-copy.js';
import {runBurikoBitmapOperation} from './bitmap-operation-jobs.js';
import {bitmapRead32, bitmapWrite32} from './bitmap-scalar.js';

export interface BurikoBitmapAffineTransform {
  x: number;
  y: number;
  pivotX: number;
  pivotY: number;
  angle: number;
  scaleX: number;
  scaleY: number;
}

export interface BurikoBitmapAffineCoordinates {
  startX: number;
  startY: number;
  columnX: number;
  columnY: number;
  rowX: number;
  rowY: number;
}

function truncate32(value: number): number {
  if (!Number.isFinite(value) || value < -0x80000000 || value >= 0x80000000) return -0x80000000;
  return Math.trunc(value) | 0;
}

/** 052030 performs each binary64 operation before its individual CVTTSD2SI store. */
export function burikoBitmapAffineCoordinates(
  transform: BurikoBitmapAffineTransform,
): BurikoBitmapAffineCoordinates {
  const {sine, cosine, perpendicularSine, perpendicularCosine} = nativeAffineSineCosine(
    transform.angle,
  );
  const inverseX = 65536 / (transform.scaleX >>> 0),
    inverseY = 65536 / (transform.scaleY >>> 0);
  const x = (transform.x | 0) * 0.0000152587890625,
    y = (transform.y | 0) * 0.0000152587890625;
  return {
    startX: truncate32(
      ((-x * cosine - y * sine) * inverseX + (transform.pivotX | 0) * 0.0000152587890625) * 65536,
    ),
    startY: truncate32(
      ((transform.pivotY | 0) * 0.0000152587890625 - (-x * sine + y * cosine) * inverseY) * 65536,
    ),
    columnX: truncate32(inverseX * cosine * 65536),
    columnY: truncate32(inverseY * sine * -65536),
    rowX: truncate32(perpendicularCosine * inverseX * -65536),
    rowY: truncate32(perpendicularSine * inverseY * 65536),
  };
}

/** 052250 accepts an integral, whole-turn, unit-scale source covering the whole target. */
export function burikoAlignedAffineSource(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  transform: BurikoBitmapAffineTransform,
): BurikoBitmap | null {
  if (
    ((transform.x | transform.y | transform.pivotX | transform.pivotY) & 65535) !== 0 ||
    (transform.angle | 0) % 0x1680000 !== 0 ||
    transform.scaleX >>> 0 !== 65536 ||
    transform.scaleY >>> 0 !== 65536
  )
    return null;
  const target = burikoBitmapRectangle(destination),
    input = burikoBitmapRectangle(source);
  translateBurikoBitmapRectangle(target, -(transform.x >> 16), -(transform.y >> 16));
  translateBurikoBitmapRectangle(input, -(transform.pivotX >> 16), -(transform.pivotY >> 16));
  if (
    target.left < input.left ||
    target.top < input.top ||
    target.right > input.right ||
    target.bottom > input.bottom
  )
    return null;
  intersectBurikoBitmapRectangle(input, target);
  translateBurikoBitmapRectangle(input, transform.pivotX >> 16, transform.pivotY >> 16);
  const clipped = {...source};
  cropBurikoBitmap(clipped, input);
  return clipped;
}

function signed16(value: number): number {
  return (value << 16) >> 16;
}

interface Sample {
  pixel: number;
  inside: boolean;
}

/** The shared SSE2 kernels use signed WORD bounds and PMADDWD pixel addressing. */
function sampleAffine(
  source: BurikoBitmap,
  fixedX: number,
  fixedY: number,
  bilinear: boolean,
  forceAlpha: boolean,
): Sample {
  if (!bilinear) {
    fixedX = (fixedX + 0x8000) | 0;
    fixedY = (fixedY + 0x8000) | 0;
  }
  const x = fixedX >> 16,
    y = fixedY >> 16;
  const width = signed16(source.width),
    height = signed16(source.height);
  if (x <= -2 || y <= -2 || x > signed16(source.width - 1) || y > signed16(source.height - 1))
    return {pixel: 0, inside: false};
  const pitch = source.stride >> 2;
  const index = (x + Math.imul(y, signed16(pitch))) | 0;
  const read = (column: number, row: number, pixelIndex: number): number => {
    if (column < 0 || row < 0 || column >= width || row >= height) return 0;
    const value = bitmapRead32(source, source.offset + (pixelIndex | 0) * 4);
    return forceAlpha ? (value | 0xff000000) >>> 0 : value;
  };
  const first = read(x, y, index);
  if (!bilinear) return {pixel: first, inside: x >= 0 && y >= 0 && x < width && y < height};
  const rightX = signed16(x + 1),
    bottomY = signed16(y + 1);
  const right = read(rightX, y, (index + 1) | 0),
    bottom = read(x, bottomY, (index + pitch) | 0),
    diagonal = read(rightX, bottomY, (index + pitch + 1) | 0);
  const fractionX = (fixedX >>> 12) & 15,
    fractionY = (fixedY >>> 12) & 15;
  let pixel = 0;
  for (let shift = 0; shift < 32; shift += 8) {
    const a = (first >>> shift) & 255,
      b = (bottom >>> shift) & 255;
    const upper = a + (((((right >>> shift) & 255) - a) * fractionX) >> 4),
      lower = b + (((((diagonal >>> shift) & 255) - b) * fractionX) >> 4);
    pixel |= (upper + (((lower - upper) * fractionY) >> 4)) << shift;
  }
  return {pixel: pixel >>> 0, inside: true};
}

/** 04ec00/0500e0/050410 retain alpha while attenuating each RGB byte with PMULLW/PSRLW. */
function dimPixel(pixel: number, transparency: number): number {
  const coefficient = (256 - transparency) & 65535;
  let output = pixel & 0xff000000;
  for (let shift = 0; shift < 24; shift += 8)
    output |= (((((pixel >>> shift) & 255) * coefficient) & 65535) >>> 8) << shift;
  return output >>> 0;
}

function interpolatePixel(
  source: number,
  destination: number,
  coefficient: number,
  alpha: boolean,
): number {
  let output = alpha ? destination & 0xff000000 : 0;
  for (let shift = 0; shift < (alpha ? 24 : 32); shift += 8) {
    const first = (source >>> shift) & 255,
      second = (destination >>> shift) & 255;
    const value = alpha
      ? second + (signed16((first - second) * coefficient) >> 7)
      : first + (signed16((second - first) * coefficient) >> 7);
    output |= Math.max(0, Math.min(255, value)) << shift;
  }
  return output >>> 0;
}

/** 050ad0/050ec0 build 128 opacity entries, with entry 127 using numerator 128. */
function alphaCoefficient(pixel: number, transparency: number): number {
  const index = pixel >>> 25;
  return ((index === 127 ? 128 : index) * (256 - transparency)) >>> 8;
}

function copyDimmed(destination: BurikoBitmap, source: BurikoBitmap, transparency: number): void {
  let outputRow = destination.offset,
    inputRow = source.offset;
  for (let row = 0; row < destination.height >>> 0; row++) {
    let column = 0;
    for (; column + 1 < destination.width >>> 0; column += 2) {
      const first = dimPixel(bitmapRead32(source, inputRow + column * 4), transparency),
        second = dimPixel(bitmapRead32(source, inputRow + column * 4 + 4), transparency);
      bitmapWrite32(destination, outputRow + column * 4, first);
      bitmapWrite32(destination, outputRow + column * 4 + 4, second);
    }
    if (column < destination.width >>> 0)
      bitmapWrite32(
        destination,
        outputRow + column * 4,
        dimPixel(bitmapRead32(source, inputRow + column * 4), transparency),
      );
    outputRow += (destination.stride >> 2) * 4;
    inputRow += (source.stride >> 2) * 4;
  }
}

function affinePixels(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  transform: BurikoBitmapAffineTransform,
  transparency: number,
  bilinear: boolean,
  mode: 'copy' | 'dim' | 'mix' | 'alpha',
): void {
  const coordinates = burikoBitmapAffineCoordinates(transform);
  const forceAlpha = destination.format === 2 && source.format === 1;
  let rowX = coordinates.startX,
    rowY = coordinates.startY,
    outputRow = destination.offset;
  for (let row = 0; row < destination.height >>> 0; row++) {
    let x = rowX,
      y = rowY;
    for (let column = 0; column < destination.width >>> 0; column += 2) {
      const count = column + 1 < destination.width >>> 0 ? 2 : 1;
      const first = sampleAffine(source, x, y, bilinear, forceAlpha);
      x = (x + coordinates.columnX) | 0;
      y = (y + coordinates.columnY) | 0;
      const second = count === 2 ? sampleAffine(source, x, y, bilinear, forceAlpha) : null;
      if (count === 2) {
        x = (x + coordinates.columnX) | 0;
        y = (y + coordinates.columnY) | 0;
      }
      const offset = outputRow + column * 4;
      if (mode === 'alpha' && first.pixel >>> 24 === 0 && (second?.pixel ?? 0) >>> 24 === 0)
        continue;
      let firstPixel = first.pixel,
        secondPixel = second?.pixel ?? 0;
      if (mode === 'dim') {
        firstPixel = dimPixel(firstPixel, transparency);
        secondPixel = dimPixel(secondPixel, transparency);
      } else if (mode === 'mix' || mode === 'alpha') {
        // 051640's single nearest tail writes zero if its source coordinate misses.
        if (!(mode === 'mix' && !bilinear && count === 1 && !first.inside)) {
          const oldFirst = bitmapRead32(destination, offset);
          const oldSecond = count === 2 ? bitmapRead32(destination, offset + 4) : 0;
          firstPixel = interpolatePixel(
            firstPixel,
            oldFirst,
            mode === 'alpha' ? alphaCoefficient(firstPixel, transparency) : transparency >>> 1,
            mode === 'alpha',
          );
          if (count === 2)
            secondPixel = interpolatePixel(
              secondPixel,
              oldSecond,
              mode === 'alpha' ? alphaCoefficient(secondPixel, transparency) : transparency >>> 1,
              mode === 'alpha',
            );
        }
      }
      bitmapWrite32(destination, offset, firstPixel);
      if (count === 2) bitmapWrite32(destination, offset + 4, secondPixel);
    }
    rowX = (rowX + coordinates.rowX) | 0;
    rowY = (rowY + coordinates.rowY) | 0;
    outputRow += (destination.stride >> 2) * 4;
  }
}

function affineBitmap(
  compositor: BurikoBitmapCompositor,
  destination: BurikoBitmap,
  source: BurikoBitmap,
  transform: BurikoBitmapAffineTransform,
  transparency: number,
  sampling: number,
  parallel: boolean,
  blend: boolean,
): 0 | 0x13 {
  if (transform.scaleX >>> 0 === 0 || transform.scaleY >>> 0 === 0) return 0x13;
  transparency >>>= 0;
  const aligned = burikoAlignedAffineSource(destination, source, transform);
  if (aligned !== null) {
    if (blend) compositor.composite(destination, aligned, 0x20, transparency);
    else if (transparency === 0) compositor.copy(destination, aligned);
    else if (destination.format === source.format && (source.format === 1 || source.format === 2))
      copyDimmed(destination, aligned, transparency);
    return 0;
  }
  if (
    parallel &&
    runBurikoBitmapOperation(
      compositor.processing,
      [destination],
      destination,
      0,
      (bitmaps, point) => {
        if (point === null) throw new Error('Buriko affine strip is missing its native point');
        affineBitmap(
          compositor,
          bitmaps[0]!,
          source,
          {...transform, x: point[0], y: point[1]},
          transparency,
          sampling,
          false,
          blend,
        );
      },
      [transform.x, transform.y],
    )
  )
    return 0;
  let mode: 'copy' | 'dim' | 'mix' | 'alpha';
  if (blend) {
    if (destination.format !== 1 || transparency >= 256) return 0;
    if (source.format === 2) mode = 'alpha';
    else if (source.format === 1) mode = transparency === 0 ? 'copy' : 'mix';
    else return 0;
  } else if (destination.format === source.format && (source.format === 1 || source.format === 2)) {
    if (transparency >= 256) {
      clearBurikoBitmap(destination);
      return 0;
    }
    mode = transparency === 0 ? 'copy' : 'dim';
  } else if (destination.format === 2 && source.format === 1) mode = 'dim';
  else return 0;
  affinePixels(destination, source, transform, transparency, (sampling | 0) !== 0, mode);
  return 0;
}

/** 052480: affine copy/dimming, with the actual optional shared distributed strip path. */
function transformBurikoBitmapPixels(
  compositor: BurikoBitmapCompositor,
  destination: BurikoBitmap,
  source: BurikoBitmap,
  transform: BurikoBitmapAffineTransform,
  transparency: number,
  sampling: number,
  parallel = false,
): 0 | 0x13 {
  return affineBitmap(
    compositor,
    destination,
    source,
    transform,
    transparency,
    sampling,
    parallel,
    false,
  );
}

/** 052710: affine RGB destination blending, retaining native Q7 opacity coefficients. */
function blendTransformedBurikoBitmapPixels(
  compositor: BurikoBitmapCompositor,
  destination: BurikoBitmap,
  source: BurikoBitmap,
  transform: BurikoBitmapAffineTransform,
  transparency: number,
  sampling: number,
  parallel = false,
): 0 | 0x13 {
  return affineBitmap(
    compositor,
    destination,
    source,
    transform,
    transparency,
    sampling,
    parallel,
    true,
  );
}

export const transformBurikoBitmap = withBurikoBitmapText(transformBurikoBitmapPixels, {
  alternateArgs: (args) => {
    const alternate = [...args] as Parameters<typeof transformBurikoBitmapPixels>;
    alternate[6] = false;
    return alternate;
  },
  destination: 1,
  source: 2,
  replace: true,
  applied: (result, args) =>
    result === 0 &&
    (args[2].format === 1 || args[2].format === 2) &&
    (args[1].format === args[2].format || (args[1].format === 2 && args[2].format === 1)),
  opacity: (args) => (256 - args[4]) / 256,
  map: (x, y, args) => {
    const coordinate = burikoBitmapAffineCoordinates(args[3]),
      determinant = coordinate.columnX * coordinate.rowY - coordinate.rowX * coordinate.columnY,
      u = x * 65536 - coordinate.startX,
      v = y * 65536 - coordinate.startY;
    return [
      (u * coordinate.rowY - v * coordinate.rowX) / determinant,
      (v * coordinate.columnX - u * coordinate.columnY) / determinant,
    ];
  },
});

export const blendTransformedBurikoBitmap = withBurikoBitmapText(
  blendTransformedBurikoBitmapPixels,
  {
    alternateArgs: (args) => {
      const alternate = [...args] as Parameters<typeof blendTransformedBurikoBitmapPixels>;
      alternate[6] = false;
      return alternate;
    },
    destination: 1,
    source: 2,
    applied: (result, args) =>
      result === 0 &&
      args[1].format === 1 &&
      (args[2].format === 1 || args[2].format === 2) &&
      args[4] < 256,
    opacity: (args) => (256 - args[4]) / 256,
    map: (x, y, args) => {
      const coordinate = burikoBitmapAffineCoordinates(args[3]),
        determinant = coordinate.columnX * coordinate.rowY - coordinate.rowX * coordinate.columnY,
        u = x * 65536 - coordinate.startX,
        v = y * 65536 - coordinate.startY;
      return [
        (u * coordinate.rowY - v * coordinate.rowX) / determinant,
        (v * coordinate.columnX - u * coordinate.columnY) / determinant,
      ];
    },
  },
);

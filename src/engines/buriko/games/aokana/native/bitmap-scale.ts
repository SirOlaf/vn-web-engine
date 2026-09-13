import type {AokanaBitmap} from './bitmap.js';
import {bitmapRead32, bitmapWrite32} from './bitmap-scalar.js';

function unsignedDivide(numerator: number, denominator: number): number {
  denominator >>>= 0;
  if (denominator === 0) throw new RangeError('Aokana bitmap scale divides by zero');
  return Math.floor((numerator >>> 0) / denominator) >>> 0;
}
function int64Low(value: number): number {
  if (!Number.isFinite(value) || value < -(2 ** 63) || value >= 2 ** 63) return 0;
  return Number(BigInt.asUintN(32, BigInt(Math.trunc(value))));
}

/** 0f6720 interpolates all four bytes; missing right/bottom neighbors use the native zero pixel. */
function bilinear(source: AokanaBitmap, x: number, y: number): number {
  x >>>= 0;
  y >>>= 0;
  const column = x >>> 16,
    row = y >>> 16;
  const offset = source.offset + (Math.imul(source.stride, row) >>> 0) + ((column * 4) >>> 0);
  const first = bitmapRead32(source, offset);
  const hasRight = column < (source.width - 1) >>> 0;
  const hasBottom = row < (source.height - 1) >>> 0;
  const right = hasRight ? bitmapRead32(source, offset + 4) : 0;
  const bottom = hasBottom ? bitmapRead32(source, offset + (source.stride | 0)) : 0;
  const diagonal =
    hasRight && hasBottom ? bitmapRead32(source, offset + (source.stride | 0) + 4) : 0;
  const fractionX = (x >>> 8) & 255,
    fractionY = (y >>> 8) & 255;
  let result = 0;
  for (let shift = 0; shift < 32; shift += 8) {
    const upper =
      ((first >>> shift) & 255) * (256 - fractionX) + ((right >>> shift) & 255) * fractionX;
    const lower =
      ((bottom >>> shift) & 255) * (256 - fractionX) + ((diagonal >>> shift) & 255) * fractionX;
    result |= ((upper * (256 - fractionY) + lower * fractionY) >>> 16) << shift;
  }
  return result >>> 0;
}

/** 0f68d0 accumulates Q8 cell coverage with PMULLW/PADDUSW, including alpha-zero colors. */
function weightedBox(
  source: AokanaBitmap,
  extentX: number,
  extentY: number,
  x: number,
  y: number,
): number {
  const left = Math.max(0, (x >>> 8) | 0),
    top = Math.max(0, (y >>> 8) | 0);
  const right = Math.min((source.width << 8) >>> 0, ((x >>> 8) + extentX) >>> 0);
  const bottom = Math.min((source.height << 8) >>> 0, ((y >>> 8) + extentY) >>> 0);
  const denominator = (Math.imul((bottom - top) | 0, (right - left) | 0) >> 8) >>> 0;
  const sums = [0, 0, 0, 0];
  let rowOffset = source.offset + Math.imul(top >> 8, source.stride);
  for (let row = top >>> 0; row < bottom;) {
    const endY = Math.min(((row + 256) & 0xffffff00) >>> 0, bottom);
    for (let column = left >>> 0; column < right;) {
      const endX = Math.min(((column + 256) & 0xffffff00) >>> 0, right);
      const pixel = bitmapRead32(source, rowOffset + ((column >>> 6) & 0x3fffffc));
      const factor = unsignedDivide(Math.imul(endX - column, endY - row) << 8, denominator) >>> 8;
      // 0f6c20 initializes all eight words of each of the 257 table entries to its index.
      if (factor > 256)
        throw new RangeError('Aokana scale coverage indexes outside its native coefficient table');
      for (let channel = 0; channel < 4; channel++)
        sums[channel] = Math.min(
          65535,
          sums[channel]! + ((((pixel >>> (channel * 8)) & 255) * factor) & 65535),
        );
      column = endX;
    }
    row = endY;
    rowOffset += source.stride | 0;
  }
  return (
    ((sums[0]! >>> 8) |
      ((sums[1]! >>> 8) << 8) |
      ((sums[2]! >>> 8) << 16) |
      ((sums[3]! >>> 8) << 24)) >>>
    0
  );
}

/** 0f6a70 averages RGB over visible pixels and alpha over all sampled pixels. */
function integerBox(
  source: AokanaBitmap,
  extentX: number,
  extentY: number,
  x: number,
  y: number,
): number {
  const left = x >>> 16,
    top = y >>> 16;
  const right = Math.min(source.width >>> 0, (left + ((extentX + 255) >> 8)) >>> 0);
  const bottom = Math.min(source.height >>> 0, (top + ((extentY + 255) >> 8)) >>> 0);
  const sums = [0, 0, 0, 0];
  let count = 0,
    visible = 0;
  let rowOffset = source.offset + Math.imul(source.stride, top);
  for (let row = top; row < bottom; row++) {
    if (left < right) count = (count + right - left) >>> 0;
    for (let column = left; column < right; column++) {
      const pixel = bitmapRead32(source, rowOffset + ((column * 4) >>> 0));
      if (pixel >>> 24 !== 0 || source.format === 1) {
        for (let channel = 0; channel < 4; channel++)
          sums[channel] = (sums[channel]! + ((pixel >>> (channel * 8)) & 255)) >>> 0;
        visible = (visible + 1) >>> 0;
      }
    }
    rowOffset += source.stride | 0;
  }
  const divisor = (visible | 0) > 0 ? visible : 1;
  return (
    (unsignedDivide(sums[0]!, divisor) |
      (unsignedDivide(sums[1]!, divisor) << 8) |
      (unsignedDivide(sums[2]!, divisor) << 16) |
      (unsignedDivide(sums[3]!, count) << 24)) >>>
    0
  );
}

/**
 * 0f6e60: centered Q16 scaling shared by particle variants and native surface operations.
 * Every draw uses the native bilinear, weighted-area, or integer-area kernel selected by scale.
 * It retains caller storage and padding and never creates an output bitmap.
 */
export function scaleAokanaBitmap(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  scaleX: number,
  scaleY: number = scaleX,
): void {
  scaleX >>>= 0;
  scaleY >>>= 0;
  const scaledWidth = (Math.imul(source.width, scaleX) + 0x8000) >>> 16;
  const scaledHeight = (Math.imul(source.height, scaleY) + 0x8000) >>> 16;
  if (scaledWidth === 0 || scaledHeight === 0) return;
  let extentX = unsignedDivide(0x10000, scaleX >>> 8);
  let extentY = unsignedDivide(0x10000, scaleY >>> 8);
  const offsetX = ((destination.width >>> 1) - (scaledWidth >>> 1)) | 0;
  const offsetY = ((destination.height >>> 1) - (scaledHeight >>> 1)) | 0;
  const left = Math.max(0, offsetX),
    top = Math.max(0, offsetY);
  const right = Math.min(destination.width >>> 0, (offsetX + scaledWidth) >>> 0);
  const bottom = Math.min(destination.height >>> 0, (offsetY + scaledHeight) >>> 0);
  let initialX = extentX << 7,
    initialY = extentY << 7,
    shift = 8;
  let mode: 'bilinear' | 'weighted' | 'integer';
  if ((scaleX - 0x8000) >>> 0 < 0x8000 || (scaleY - 0x8000) >>> 0 < 0x8000) mode = 'weighted';
  else if (scaleX < 0x8000 || scaleY < 0x8000) mode = 'integer';
  else {
    mode = 'bilinear';
    extentX = extentY = 512;
    initialX = initialY = 0;
    shift = 9;
  }
  const spanX = ((source.width - (extentX >> shift)) << 16) >>> 0;
  const spanY = ((source.height - (extentY >> shift)) << 16) >>> 0;
  const stepX = unsignedDivide(spanX, scaledWidth),
    stepY = unsignedDivide(spanY, scaledHeight);
  const startX = (int64Low((((left - offsetX) | 0) / scaledWidth) * spanX) + initialX) >>> 0;
  let sourceY = (int64Low((((top - offsetY) | 0) / scaledHeight) * spanY) + initialY) >>> 0;
  let rowOffset = destination.offset + Math.imul(destination.stride, top);
  const rowStep = ((destination.stride >> 2) >>> 0) * 4;
  for (let row = top; row < bottom; row++) {
    let sourceX = startX;
    for (let column = left; column < right; column++) {
      const pixel =
        mode === 'bilinear'
          ? bilinear(source, sourceX, sourceY)
          : mode === 'weighted'
            ? weightedBox(source, extentX, extentY, sourceX, sourceY)
            : integerBox(source, extentX, extentY, sourceX, sourceY);
      bitmapWrite32(destination, rowOffset + column * 4, pixel);
      sourceX = (sourceX + stepX) >>> 0;
    }
    sourceY = (sourceY + stepY) >>> 0;
    rowOffset += rowStep;
  }
}

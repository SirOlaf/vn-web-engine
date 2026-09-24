import type {AokanaBitmap} from './bitmap.js';
import {bitmapRead32, bitmapWrite32} from './bitmap-scalar.js';

function cvtt64Low(value: number): number {
  return !Number.isFinite(value) || value < -(2 ** 63) || value >= 2 ** 63
    ? 0
    : Number(BigInt.asUintN(32, BigInt(Math.trunc(value))));
}

/** F6C60, scoped to0363B0's validated format1/2 descriptors (native depth32). */
export function scaleAokanaTrueColorBitmapNearest(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  scaleX: number,
  scaleY: number,
): void {
  const spanX = (source.width << 16) >>> 0,
    spanY = (source.height << 16) >>> 0;
  const width = (Math.imul(source.width, scaleX) + 0x8000) >>> 16;
  const height = (Math.imul(source.height, scaleY) + 0x8000) >>> 16;
  if (width === 0 || height === 0) return;
  const offsetX = ((destination.width >>> 1) - (width >>> 1)) | 0;
  const offsetY = ((destination.height >>> 1) - (height >>> 1)) | 0;
  const left = Math.max(0, offsetX),
    top = Math.max(0, offsetY);
  const right = Math.min(destination.width >>> 0, (offsetX + width) >>> 0);
  const bottom = Math.min(destination.height >>> 0, (offsetY + height) >>> 0);
  const stepX = Math.floor(spanX / width),
    stepY = Math.floor(spanY / height);
  const initialY = cvtt64Low((((top - offsetY) | 0) / height) * spanY);
  const initialX = cvtt64Low((((left - offsetX) | 0) / width) * spanX);
  let fractionY = initialY & 0xffff;
  let sourceRow = source.offset + (Math.imul(initialY >>> 16, source.stride) >>> 0);
  let destinationRow = destination.offset + Math.imul(top, destination.stride);
  for (let y = top; y < bottom; y++) {
    let xCoordinate = initialX;
    for (let x = left; x < right; x++) {
      const pixel = bitmapRead32(source, sourceRow + (xCoordinate >>> 16) * 4);
      bitmapWrite32(destination, destinationRow + x * 4, pixel);
      xCoordinate = (xCoordinate + stepX) >>> 0;
    }
    const nextY = (fractionY + stepY) >>> 0;
    fractionY = nextY & 0xffff;
    destinationRow += destination.stride & ~3;
    sourceRow += (Math.imul(nextY >>> 16, source.stride) >>> 2) * 4;
  }
}

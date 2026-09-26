import {burikoBitmapPixelSize, type BurikoBitmap} from './bitmap.js';
import type {BurikoBitmapCompositor} from './bitmap-compositor.js';
import {BurikoMemoryDx} from './memory-dx.js';

/** 054f40 selects the supplied descriptor's format, or promotes default RGB to RGBA. */
export function configureBurikoOwnedBitmap(
  owner: BurikoMemoryDx,
  destination: BurikoBitmap,
  width: number,
  height: number,
  compositor: BurikoBitmapCompositor,
  source: BurikoBitmap | null = null,
): boolean {
  let format = source === null ? compositor.defaultFormat : source.format;
  if (source === null && format === 1) format = 2;
  return configureBurikoOwnedBitmapFormat(owner, destination, width, height, format);
}

/** 054f80 keeps the descriptor separate from its CMemoryDX owner. */
export function configureBurikoOwnedBitmapFormat(
  owner: BurikoMemoryDx,
  destination: BurikoBitmap,
  width: number,
  height: number,
  format: number,
): boolean {
  owner.free();
  width |= 0;
  height |= 0;
  format >>>= 0;
  destination.height = height;
  destination.format = format;
  destination.width = width;
  const bytesPerPixel = burikoBitmapPixelSize(format);
  destination.bytesPerPixel = bytesPerPixel;
  destination.stride = Math.imul(bytesPerPixel, width);
  destination.offset = 0;
  destination.storage =
    width !== 0 && height !== 0
      ? owner.allocate(Math.imul(height, destination.stride) >>> 0)
      : null;
  return destination.storage !== null;
}

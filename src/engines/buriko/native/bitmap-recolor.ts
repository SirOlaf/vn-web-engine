import {withBurikoBitmapText} from './bitmap-dom-text.js';
import type {BurikoBitmap} from './bitmap.js';
import {bitmapRead32, bitmapWrite32} from './bitmap-scalar.js';

/** 054C30 replaces RGB while preserving the source alpha, in source row order. */
function recolorBurikoBitmapAlphaPixels(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  color: number,
): void {
  if (destination.format !== 2 || source.format !== 2) return;
  for (let y = 0; y < source.height >>> 0; y++)
    for (let x = 0; x < source.width >>> 0; x++) {
      const input = source.offset + y * source.stride + x * 4,
        output = destination.offset + y * destination.stride + x * 4,
        sourceStorage = source.storage,
        destinationStorage = destination.storage;
      if (sourceStorage === null || destinationStorage === null)
        throw new TypeError('Buriko alpha recolor dereferences a null bitmap');
      sourceStorage.range(input, 4, true);
      destinationStorage.range(output, 4, false);
      destinationStorage.view.setUint32(
        output,
        (sourceStorage.view.getUint32(input, true) & 0xff000000) | (color & 0xffffff),
        true,
      );
      destinationStorage.written(output, 4);
    }
}

export const recolorBurikoBitmapAlpha = withBurikoBitmapText(recolorBurikoBitmapAlphaPixels, {
  color: (_, args) => args[2] & 0xffffff,
  replace: true,
  applied: (_, args) => args[0].format === 2 && args[1].format === 2,
});

/** 036B60 changes matching pixels without damage or locking. */
function replaceBurikoBitmapColorPixels(
  bitmap: BurikoBitmap,
  search: number,
  replacement: number,
): void {
  search >>>= 0;
  replacement >>>= 0;
  if (bitmap.format !== 1 && bitmap.format !== 2) return;
  const rgbOnly = bitmap.format === 1 || (search & 0xff000000) === 0;
  for (let y = 0; y < bitmap.height >>> 0; y++)
    for (let x = 0; x < bitmap.width >>> 0; x++) {
      const offset = bitmap.offset + y * bitmap.stride + x * 4;
      const pixel = bitmapRead32(bitmap, offset);
      if (rgbOnly ? (pixel & 0xffffff) === (search & 0xffffff) : pixel === search)
        bitmapWrite32(
          bitmap,
          offset,
          rgbOnly
            ? (bitmap.format === 2 ? pixel & 0xff000000 : 0) | (replacement & 0xffffff)
            : replacement,
        );
    }
}

export const replaceBurikoBitmapColor = withBurikoBitmapText(replaceBurikoBitmapColorPixels, {
  source: 0,
  replace: true,
  color: (color, args) =>
    (color & 0xffffff) === (args[1] & 0xffffff) ? args[2] & 0xffffff : color,
  applied: (_, args) => args[0].format === 1 || args[0].format === 2,
});

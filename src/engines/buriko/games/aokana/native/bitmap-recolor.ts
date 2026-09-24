import type {AokanaBitmap} from './bitmap.js';

/** 054C30 replaces RGB while preserving the source alpha, in source row order. */
export function recolorAokanaBitmapAlpha(
  destination: AokanaBitmap,
  source: AokanaBitmap,
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
        throw new TypeError('Aokana alpha recolor dereferences a null bitmap');
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

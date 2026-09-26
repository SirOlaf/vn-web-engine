import {withBurikoBitmapText} from './bitmap-dom-text.js';
import type {BurikoBitmap} from './bitmap.js';
import {bitmapRead8, bitmapWrite8} from './bitmap-scalar.js';

/** 046910 dispatches the source-sized scalar 045840/045770 kernels. */
function convertBurikoBitmapToMaskPixels(
  destination: BurikoBitmap,
  source: BurikoBitmap,
): 0 | 9 | 10 {
  if (destination.format !== 3) return 10;
  if (source.format !== 1 && source.format !== 2) return 9;
  let outputRow = destination.offset,
    inputRow = source.offset;
  for (let y = 0; y < source.height >>> 0; y++) {
    let output = outputRow,
      input = inputRow;
    for (let x = 0; x < source.width >>> 0; x++) {
      const green = bitmapRead8(source, input + 1),
        red = bitmapRead8(source, input + 2),
        blue = bitmapRead8(source, input);
      const weighted = green * 151 + red * 77 + blue * 28;
      const value =
        source.format === 2 ? (weighted * bitmapRead8(source, input + 3)) >>> 16 : weighted >>> 8;
      bitmapWrite8(destination, output, value);
      output += destination.bytesPerPixel >>> 0;
      input += source.bytesPerPixel >>> 0;
    }
    outputRow += destination.stride | 0;
    inputRow += source.stride | 0;
  }
  return 0;
}

/** 0468A0 only complements bytes of an existing format-three descriptor. */
function invertBurikoBitmapMaskPixels(bitmap: BurikoBitmap): boolean {
  if (bitmap.format !== 3) return false;
  let row = bitmap.offset;
  for (let y = 0; y < bitmap.height >>> 0; y++) {
    let offset = row;
    for (let x = 0; x < bitmap.width >>> 0; x++) {
      bitmapWrite8(bitmap, offset, ~bitmapRead8(bitmap, offset));
      offset += bitmap.bytesPerPixel >>> 0;
    }
    row += bitmap.stride | 0;
  }
  return true;
}

export const convertBurikoBitmapToMask = withBurikoBitmapText(convertBurikoBitmapToMaskPixels, {
  replace: true,
  applied: (result) => result === 0,
});

export const invertBurikoBitmapMask = withBurikoBitmapText(invertBurikoBitmapMaskPixels, {
  source: 0,
  replace: true,
  applied: (result) => result,
});

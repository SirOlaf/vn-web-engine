import {withAokanaBitmapText} from './bitmap-dom-text.js';
import type {AokanaBitmap} from './bitmap.js';
import {bitmapRead8, bitmapRead32, bitmapWrite8, bitmapWrite32} from './bitmap-scalar.js';

/** 03E2A0 saturating-adds the alpha mask to four pixels, then the two/one tails. */
function makeAokanaBitmapOpaquePixels(bitmap: AokanaBitmap): void {
  for (let y = 0; y < bitmap.height >>> 0; y++) {
    const row = bitmap.offset + y * bitmap.stride;
    let x = 0;
    const apply = (count: number): void => {
      const values = Array.from({length: count}, (_, index) =>
        bitmapRead32(bitmap, row + (x + index) * 4),
      );
      for (let index = 0; index < count; index++)
        bitmapWrite32(bitmap, row + (x + index) * 4, values[index]! | 0xff000000);
      x += count;
    };
    for (; x + 3 < bitmap.width >>> 0;) apply(4);
    if ((bitmap.width & 2) !== 0) apply(2);
    if ((bitmap.width & 1) !== 0) apply(1);
  }
}

/** 03FA20 removes a selected matte from partial-alpha imported pixels. */
function removeAokanaBitmapMattePixels(bitmap: AokanaBitmap, color: number): 0 | 1 {
  color >>>= 0;
  if (color === 0 || bitmap.format !== 2) return 0;
  for (let y = 0; y < bitmap.height >>> 0; y++)
    for (let x = 0; x < bitmap.width >>> 0; x++) {
      const offset = bitmap.offset + y * bitmap.stride + x * bitmap.bytesPerPixel;
      const alpha = bitmapRead8(bitmap, offset + 3);
      if (((alpha - 1) & 255) >= 254) continue;
      const remaining = 255 - alpha;
      for (let channel = 0; channel < 3; channel++) {
        const matte = (color >>> (channel * 8)) & 255;
        const background = Math.trunc((matte * remaining) / 255);
        const value = Math.trunc(
          ((bitmapRead8(bitmap, offset + channel) - background) * 255) / alpha,
        );
        bitmapWrite8(bitmap, offset + channel, Math.max(0, Math.min(255, value)));
      }
    }
  return 1;
}

export const makeAokanaBitmapOpaque = withAokanaBitmapText(makeAokanaBitmapOpaquePixels, {
  source: 0,
  replace: true,
});

export const removeAokanaBitmapMatte = withAokanaBitmapText(removeAokanaBitmapMattePixels, {
  source: 0,
  replace: true,
  applied: (result) => result === 1,
});

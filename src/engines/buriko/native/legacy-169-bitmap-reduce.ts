import {withBurikoBitmapText} from './bitmap-dom-text.js';
import type {BurikoBitmap} from './bitmap.js';
import {bitmapRead32, bitmapWrite32} from './bitmap-scalar.js';

function average(pixels: readonly number[]): number {
  let output = 0;
  for (let shift = 0; shift < 32; shift += 8) {
    let sum = 0;
    for (const pixel of pixels) sum += (pixel >>> shift) & 255;
    output |= Math.floor(sum / pixels.length) << shift;
  }
  return output >>> 0;
}

/** 004124B0/004124E0: MMX zero-extends and sums four bytes before PSRLW 2.
 * The 1.69 kernel truncates once; the later PAVGB kernel rounds twice. */
function reducePixels(destination: BurikoBitmap, source: BurikoBitmap): void {
  if (destination.format !== source.format || (source.format !== 1 && source.format !== 2)) return;
  if (source.width < 2 || source.height < 2)
    throw new RangeError(
      'Buriko 1.69 half reduction enters its native do-while loop with no full pair',
    );
  for (let y = 0; y < source.height; y += 2)
    for (let x = 0; x < source.width; x += 2) {
      const first = source.offset + y * source.stride + x * 4;
      const pixels = [bitmapRead32(source, first)];
      if (x + 1 < source.width) pixels.push(bitmapRead32(source, first + 4));
      if (y + 1 < source.height) {
        pixels.push(bitmapRead32(source, first + source.stride));
        if (x + 1 < source.width) pixels.push(bitmapRead32(source, first + source.stride + 4));
      }
      bitmapWrite32(
        destination,
        destination.offset + (y >>> 1) * destination.stride + (x >>> 1) * 4,
        average(pixels),
      );
    }
}

export const reduceLegacy169BitmapHalf = withBurikoBitmapText(reducePixels, {
  replace: true,
  region: (args) => ({
    x: 0,
    y: 0,
    width: Math.ceil(args[1].width / 2),
    height: Math.ceil(args[1].height / 2),
  }),
  applied: (_, args) =>
    args[0].format === args[1].format && (args[1].format === 1 || args[1].format === 2),
  map: (x, y) => [x / 2, y / 2],
});

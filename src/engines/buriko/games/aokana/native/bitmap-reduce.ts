import type {AokanaBitmap} from './bitmap.js';
import {bitmapRead32, bitmapWrite32} from './bitmap-scalar.js';

const average = (first: number, second: number): number => {
  let value = 0;
  for (let channel = 0; channel < 32; channel += 8)
    value |= ((((first >>> channel) & 255) + ((second >>> channel) & 255) + 1) >>> 1) << channel;
  return value >>> 0;
};

/** 0549E0/053750: byte-wise PAVGB reduction, vertical pair before horizontal pair.
 * Odd column/row/corner writes follow the native available-destination tests;
 * untouched output padding retains its previous bytes. RGB's fourth byte is
 * averaged too, exactly like RGBA. No alpha-weighted resampling is substituted. */
export function reduceAokanaBitmapHalf(destination: AokanaBitmap, source: AokanaBitmap): void {
  if (destination.format !== source.format || (source.format !== 1 && source.format !== 2)) return;
  const width = Math.min(destination.width >>> 0, source.width >>> 1),
    height = Math.min(destination.height >>> 0, source.height >>> 1),
    oddColumn = (source.width & 1) !== 0 && (destination.width * 2 >>> 0) > (source.width >>> 0),
    oddRow = (source.height & 1) !== 0 && (destination.height * 2 >>> 0) > (source.height >>> 0);
  const sourceRowStep = source.stride << 1;
  for (let y = 0; y < height; y++) {
    const top = source.offset + y * sourceRowStep,
      bottom = top + source.stride,
      output = destination.offset + y * destination.stride;
    const reduce = (x: number): number => average(
      average(bitmapRead32(source, top + x * 8), bitmapRead32(source, bottom + x * 8)),
      average(bitmapRead32(source, top + x * 8 + 4), bitmapRead32(source, bottom + x * 8 + 4)),
    );
    let x = 0;
    for (; x + 1 < width; x += 2) {
      const first = reduce(x), second = reduce(x + 1);
      bitmapWrite32(destination, output + x * 4, first);
      bitmapWrite32(destination, output + x * 4 + 4, second);
    }
    if (x < width) bitmapWrite32(destination, output + x * 4, reduce(x));
    if (oddColumn)
      bitmapWrite32(destination, output + width * 4,
        average(bitmapRead32(source, top + width * 8), bitmapRead32(source, bottom + width * 8)));
  }
  if (oddRow) {
    const input = source.offset + height * sourceRowStep,
      output = destination.offset + height * destination.stride;
    const reduce = (x: number): number => average(
      bitmapRead32(source, input + x * 8), bitmapRead32(source, input + x * 8 + 4));
    let x = 0;
    for (; x + 1 < width; x += 2) {
      const first = reduce(x), second = reduce(x + 1);
      bitmapWrite32(destination, output + x * 4, first);
      bitmapWrite32(destination, output + x * 4 + 4, second);
    }
    if (x < width) bitmapWrite32(destination, output + x * 4, reduce(x));
    if (oddColumn)
      bitmapWrite32(destination, output + width * 4, bitmapRead32(source, input + width * 8));
  }
}

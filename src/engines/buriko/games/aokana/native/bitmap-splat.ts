import type {AokanaBitmap} from './bitmap.js';
import {clearAokanaBitmap} from './bitmap-copy.js';
import {bitmapRead32, bitmapWrite32} from './bitmap-scalar.js';

/** 054A00/053910: forward RGB accumulation using the native source-stride addressing. */
export function splatAokanaBitmap(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  scaleX: number,
  scaleY: number,
  level: number,
): void {
  if (destination.format !== 1 || source.format !== 1) return;
  const width = source.width >>> 0,
    height = source.height >>> 0,
    stride = source.stride >> 2,
    initialX = ((Math.imul(width, scaleX) >>> 1) - scaleX) | 0,
    initialY = ((Math.imul(height, scaleY) >>> 1) - scaleY) | 0,
    stepX = (65536 - scaleX) | 0,
    stepY = (65536 - scaleY) | 0,
    coefficients = new Uint16Array(129);
  let accumulator = 0;
  for (let index = 0; index < 129; index++) {
    coefficients[index] = accumulator >>> 8;
    accumulator = (accumulator + (256 - level)) >>> 0;
  }
  clearAokanaBitmap(destination);
  const accumulate = (offset: number, weight: number, pixel: number): void => {
    // 053AF7 reads the destination before indexing the coefficient stack.
    const old = bitmapRead32(destination, offset),
      coefficient = coefficients[weight];
    if (coefficient === undefined)
      throw new RangeError('Aokana splat reads outside its native coefficient stack');
    let result = old & 0xff000000;
    for (const shift of [0, 8, 16]) {
      const addition = ((((pixel >>> shift) & 255) * coefficient) & 65535) >>> 7;
      result |= Math.min(255, ((old >>> shift) & 255) + addition) << shift;
    }
    bitmapWrite32(destination, offset, result);
  };
  let y = initialY,
    sourceRow = source.offset;
  for (let row = 0; row < height; row++) {
    let x = initialX;
    const rowY = y;
    y = (y + stepY) | 0;
    for (let column = 0; column < width; column++) {
      const pixel = bitmapRead32(source, sourceRow + column * 4),
        fx = (x & 65535) >>> 9,
        fy = (rowY & 65535) >>> 9,
        weight0 = ((128 - fx) * (128 - fy)) >>> 7,
        weight1 = (fx * (128 - fy)) >>> 7,
        weight2 = ((128 - fx) * fy) >>> 7,
        weight3 = (fx * fy) >>> 7,
        index =
          (Math.min(x >>> 16, 32767) +
            Math.imul(Math.min(rowY >>> 16, 32767), (stride << 16) >> 16)) |
          0;
      x = (x + stepX) | 0;
      accumulate(destination.offset + index * 4, weight0, pixel);
      if (weight1 > 0) accumulate(destination.offset + ((index + 1) | 0) * 4, weight1, pixel);
      if (weight2 > 0) accumulate(destination.offset + ((index + stride) | 0) * 4, weight2, pixel);
      if (weight3 > 0)
        accumulate(destination.offset + ((index + stride) | 0) * 4 + 4, weight3, pixel);
    }
    sourceRow += stride * 4;
  }
}

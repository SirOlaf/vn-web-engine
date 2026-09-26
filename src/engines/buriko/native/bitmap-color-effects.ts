import {withBurikoBitmapText} from './bitmap-dom-text.js';
import type {BurikoBitmap} from './bitmap.js';
import type {BurikoBitmapCompositor} from './bitmap-compositor.js';
import {runBurikoBitmapOperation} from './bitmap-operation-jobs.js';
import {bitmapRead32, bitmapWrite32} from './bitmap-scalar.js';

function signedWord(value: number): number {
  return (value << 16) >> 16;
}

function packByte(value: number): number {
  return Math.max(0, Math.min(255, value));
}

/** 046450/0462b0 XOR against color; 0460f0/045f30 colorize the 29/150/77 luminance sum. */
function transformColorsPixels(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  color: number,
  opacity: number,
  luminance: boolean,
): void {
  const width = Math.min(destination.width >>> 0, source.width >>> 0),
    height = Math.min(destination.height >>> 0, source.height >>> 0),
    alpha = source.format === 2;
  const coefficient = luminance ? (opacity & 65535) >>> 1 : signedWord(opacity) >> 1;
  const transform = (pixel: number): number => {
    let result = pixel & 0xff000000;
    const sum = (pixel & 255) * 29 + ((pixel >>> 8) & 255) * 150 + ((pixel >>> 16) & 255) * 77;
    for (let shift = 0; shift < 24; shift += 8) {
      const value = (pixel >>> shift) & 255,
        component = (color >>> shift) & 255;
      const target = luminance ? (sum * component) >>> 16 : value ^ component;
      result |= packByte(value + (signedWord((target - value) * coefficient) >> 7)) << shift;
    }
    return result >>> 0;
  };
  let outputRow = destination.offset,
    inputRow = source.offset;
  for (let row = 0; row < height; row++) {
    let column = 0;
    for (; column + 1 < width; column += 2) {
      const first = bitmapRead32(source, inputRow + column * 4),
        second = bitmapRead32(source, inputRow + column * 4 + 4);
      // The RGBA kernels clear an entirely transparent pair, but transform both pixels otherwise.
      const clear = alpha && ((first | second) & 0xff000000) === 0;
      const firstResult = clear ? 0 : transform(first),
        secondResult = clear ? 0 : transform(second);
      bitmapWrite32(destination, outputRow + column * 4, firstResult);
      bitmapWrite32(destination, outputRow + column * 4 + 4, secondResult);
    }
    if ((width & 1) !== 0) {
      const pixel = bitmapRead32(source, inputRow + column * 4);
      bitmapWrite32(
        destination,
        outputRow + column * 4,
        alpha && pixel >>> 24 === 0 ? 0 : transform(pixel),
      );
    }
    outputRow += destination.stride | 0;
    inputRow += source.stride | 0;
  }
}

/** 045c60 excludes color alpha for addition; 045b30 includes it for subtraction. */
function offsetColorsPixels(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  color: number,
  opacity: number,
  subtract: boolean,
): void {
  const width = Math.min(destination.width >>> 0, source.width >>> 0),
    height = Math.min(destination.height >>> 0, source.height >>> 0);
  if (!subtract) color &= 0xffffff;
  const offsets = Array.from(
    {length: 4},
    (_, index) => (Math.imul((color >>> (index * 8)) & 255, opacity) & 65535) >>> 8,
  );
  const transform = (pixel: number): number => {
    let result = 0;
    for (let index = 0; index < 4; index++) {
      const value = (pixel >>> (index * 8)) & 255,
        offset = offsets[index]!;
      result |=
        (subtract ? Math.max(0, value - offset) : Math.min(255, value + offset)) << (index * 8);
    }
    return result >>> 0;
  };
  let outputRow = destination.offset,
    inputRow = source.offset;
  for (let row = 0; row < height; row++) {
    let column = 0;
    const group = (count: 1 | 2 | 4): void => {
      const values: number[] = [];
      for (let index = 0; index < count; index++)
        values.push(transform(bitmapRead32(source, inputRow + (column + index) * 4)));
      for (let index = 0; index < count; index++)
        bitmapWrite32(destination, outputRow + (column + index) * 4, values[index]!);
      column += count;
    };
    for (let count = width >>> 2; count !== 0; count--) group(4);
    if ((width & 2) !== 0) group(2);
    if ((width & 1) !== 0) group(1);
    outputRow += destination.stride | 0;
    inputRow += source.stride | 0;
  }
}

/** 054840's six concrete selectors, with 052a20 dispatching through the same attached pool. */
export function applyBurikoBitmapColorEffect(
  compositor: BurikoBitmapCompositor,
  destination: BurikoBitmap,
  source: BurikoBitmap,
  selector: number,
  color: number,
  opacity: number,
  parallel = false,
): 0 | 0x18 {
  selector >>>= 0;
  if (selector > 5) return 0x18;
  if (
    parallel &&
    runBurikoBitmapOperation(compositor.processing, [destination, source], source, 0, (bitmaps) => {
      applyBurikoBitmapColorEffect(compositor, bitmaps[0]!, bitmaps[1]!, selector, color, opacity);
    })
  )
    return 0;
  if (selector === 0) compositor.copy(destination, source, color);
  else if (selector === 3) compositor.tint(destination, source, color, opacity);
  else if (destination.format === source.format && (source.format === 1 || source.format === 2)) {
    if (selector === 1 || selector === 2)
      transformColors(destination, source, color, opacity, selector === 2);
    else offsetColors(destination, source, color, opacity, selector === 5);
  }
  return 0;
}

const transformColors = withBurikoBitmapText(transformColorsPixels, {
  replace: true,
  color: (pixel, args) => {
    const coefficient = args[4] ? (args[3] & 65535) >>> 1 : signedWord(args[3]) >> 1;
    const sum = (pixel & 255) * 29 + ((pixel >>> 8) & 255) * 150 + ((pixel >>> 16) & 255) * 77;
    let result = 0;
    for (let shift = 0; shift < 24; shift += 8) {
      const value = (pixel >>> shift) & 255,
        component = (args[2] >>> shift) & 255,
        target = args[4] ? (sum * component) >>> 16 : value ^ component;
      result |= packByte(value + (signedWord((target - value) * coefficient) >> 7)) << shift;
    }
    return result;
  },
});
const offsetColors = withBurikoBitmapText(offsetColorsPixels, {
  replace: true,
  color: (pixel, args) => {
    let result = 0;
    for (let shift = 0; shift < 24; shift += 8) {
      const value = (pixel >>> shift) & 255,
        offset = (Math.imul((args[2] >>> shift) & 255, args[3]) & 65535) >>> 8;
      result |= (args[4] ? Math.max(0, value - offset) : Math.min(255, value + offset)) << shift;
    }
    return result;
  },
});

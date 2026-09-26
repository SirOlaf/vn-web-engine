import {withAokanaBitmapText} from './bitmap-dom-text.js';
import type {AokanaBitmap} from './bitmap.js';
import {
  bitmapRead8,
  bitmapRead16,
  bitmapRead32,
  bitmapWrite8,
  bitmapWrite16,
  bitmapWrite32,
} from './bitmap-scalar.js';
import {
  readAokanaPixelPair,
  saturateAokanaByte,
  visitAokanaPixelPairs,
  writeAokanaMappedPairs,
  writeAokanaPixelPair,
} from './bitmap-pairs.js';

function intersectDimensions(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  wordRows: boolean,
): readonly [AokanaBitmap, AokanaBitmap] {
  const width = Math.min(destination.width >>> 0, source.width >>> 0);
  const height = Math.min(destination.height >>> 0, source.height >>> 0);
  return [
    {
      ...destination,
      width,
      height,
      stride: wordRows ? (destination.stride >> 2) * 4 : destination.stride,
    },
    {...source, width, height, stride: wordRows ? (source.stride >> 2) * 4 : source.stride},
  ];
}

/** 14004e120/14004df10: screen; the alpha-bearing source is premultiplied in two stages. */
function screenAokanaBitmapPixels(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  opacity: number,
  sourceHasAlpha: boolean,
): void {
  const [target, input] = intersectDimensions(destination, source, true);
  const pixel = (sourcePixel: number, destinationPixel: number): number => {
    const coefficient = sourceHasAlpha ? Math.imul(sourcePixel >>> 24, opacity) >>> 8 : opacity;
    let result = 0;
    for (let shift = 0; shift < 32; shift += 8) {
      const old = (destinationPixel >>> shift) & 255;
      const channel =
        sourceHasAlpha && shift === 24
          ? 0
          : Math.imul((sourcePixel >>> shift) & 255, coefficient) >>> 8;
      result |= saturateAokanaByte(channel + old - (Math.imul(channel, old) >>> 8)) << shift;
    }
    return result >>> 0;
  };
  visitAokanaPixelPairs(
    target,
    input,
    (pixels, offset) => {
      if (sourceHasAlpha && pixels[0] >>> 24 === 0 && pixels[1] >>> 24 === 0) return;
      const old = readAokanaPixelPair(target, offset);
      writeAokanaPixelPair(target, offset, [pixel(pixels[0], old[0]), pixel(pixels[1], old[1])]);
    },
    (value, offset) => {
      if (!sourceHasAlpha || value >>> 24 !== 0)
        bitmapWrite32(target, offset, pixel(value, bitmapRead32(target, offset)));
    },
  );
}

function overlayChannel(source: number, destination: number, selectSource: boolean): number {
  const product = Math.imul(source, destination) >>> 7;
  return (selectSource ? source : destination) > 127
    ? 2 * (source + destination) - 255 - product
    : product;
}

/**
 * 14004d930/dbd0/dd90 (destination threshold) and 14004d350/d5f0/d7b0 (source threshold).
 * Source-alpha weights are truncated to 12 fractional bits before signed high multiplication.
 */
function overlayAokanaBitmapPixels(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  opacity: number,
  sourceHasAlpha: boolean,
  selectSource: boolean,
): void {
  const [target, input] = intersectDimensions(destination, source, true);
  const pixel = (sourcePixel: number, destinationPixel: number): number => {
    const coefficient = sourceHasAlpha
      ? Math.imul(sourcePixel >>> 24, opacity) >>> 4
      : opacity * 16;
    let result = 0;
    for (let shift = 0; shift < 32; shift += 8) {
      const old = (destinationPixel >>> shift) & 255;
      const value = overlayChannel((sourcePixel >>> shift) & 255, old, selectSource);
      let channel: number;
      if (!sourceHasAlpha && opacity >= 256) channel = value;
      else if (sourceHasAlpha && shift === 24) channel = old;
      else channel = old + (Math.imul((value - old) * 16, coefficient) >> 16);
      result |= saturateAokanaByte(channel) << shift;
    }
    return result >>> 0;
  };
  visitAokanaPixelPairs(
    target,
    input,
    (pixels, offset) => {
      if (sourceHasAlpha && pixels[0] >>> 24 === 0 && pixels[1] >>> 24 === 0) return;
      const old = readAokanaPixelPair(target, offset);
      writeAokanaPixelPair(target, offset, [pixel(pixels[0], old[0]), pixel(pixels[1], old[1])]);
    },
    (value, offset) => {
      if (!sourceHasAlpha || value >>> 24 !== 0)
        bitmapWrite32(target, offset, pixel(value, bitmapRead32(target, offset)));
    },
  );
}

/** 14004cdc0 multiplies every target byte by 256-floor(sourceAlpha*opacity/256). */
function eraseAokanaAlphaFromRgbPixels(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  opacity: number,
): void {
  const [target, input] = intersectDimensions(destination, source, false);
  const pixel = (sourcePixel: number, destinationPixel: number): number => {
    const coefficient = 256 - (Math.imul(sourcePixel >>> 24, opacity) >>> 8);
    let result = 0;
    for (let shift = 0; shift < 32; shift += 8)
      result |= (Math.imul((destinationPixel >>> shift) & 255, coefficient) >>> 8) << shift;
    return result >>> 0;
  };
  visitAokanaPixelPairs(
    target,
    input,
    (pixels, offset) => {
      if (pixels[0] >>> 24 === 0 && pixels[1] >>> 24 === 0) return;
      const old = readAokanaPixelPair(target, offset);
      writeAokanaPixelPair(target, offset, [pixel(pixels[0], old[0]), pixel(pixels[1], old[1])]);
    },
    (value, offset) => {
      if (value >>> 24 !== 0)
        bitmapWrite32(target, offset, pixel(value, bitmapRead32(target, offset)));
    },
  );
}

/** 14004cc30/14004cac0 preserve RGB; the fractional odd tail keeps eight extra alpha bits. */
function eraseAokanaAlphaPixels(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  opacity: number,
): void {
  const [target, input] = intersectDimensions(destination, source, false);
  const pairPixel = (value: number, old: number): number => {
    const coefficient =
      256 - (opacity >= 256 ? value >>> 24 : Math.imul(value >>> 24, opacity) >>> 8);
    return (old & 0xffffff) | ((Math.imul(old >>> 24, coefficient) >>> 8) << 24);
  };
  visitAokanaPixelPairs(
    target,
    input,
    (pixels, offset) => {
      if (pixels[0] >>> 24 === 0 && pixels[1] >>> 24 === 0) return;
      const old = readAokanaPixelPair(target, offset);
      writeAokanaPixelPair(target, offset, [
        pairPixel(pixels[0], old[0]),
        pairPixel(pixels[1], old[1]),
      ]);
    },
    (value, offset) => {
      if (value >>> 24 === 0) return;
      const old = bitmapRead32(target, offset);
      const alpha =
        opacity >= 256
          ? Math.imul(old >>> 24, 256 - (value >>> 24)) >>> 8
          : Math.imul(old >>> 24, 65536 - Math.imul(value >>> 24, opacity)) >>> 16;
      bitmapWrite32(target, offset, (old & 0xffffff) | (alpha << 24));
    },
  );
}

/** 14004c950/14004c840 use 256 for paired mask erasure but 255 for the scalar tail. */
function eraseAokanaAlphaFromMaskPixels(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  opacity: number,
): void {
  const [target, input] = intersectDimensions(destination, source, false);
  const width = input.width >>> 0;
  for (let y = 0; y < input.height >>> 0; y++) {
    const sourceRow = input.offset + y * input.stride;
    const targetRow = target.offset + y * target.stride;
    let x = 0;
    for (; x + 1 < width; x += 2) {
      const pixels = readAokanaPixelPair(input, sourceRow + x * 4);
      if (pixels[0] >>> 24 === 0 && pixels[1] >>> 24 === 0) continue;
      const old = bitmapRead16(target, targetRow + x);
      let result = 0;
      for (let index = 0; index < 2; index++) {
        const alpha = pixels[index]! >>> 24;
        const coefficient = 256 - (opacity >= 256 ? alpha : Math.imul(alpha, opacity) >>> 8);
        result |= (Math.imul((old >>> (index * 8)) & 255, coefficient) >>> 8) << (index * 8);
      }
      bitmapWrite16(target, targetRow + x, result);
    }
    if (x < width) {
      const alpha = bitmapRead32(input, sourceRow + x * 4) >>> 24;
      if (alpha !== 0) {
        const old = bitmapRead8(target, targetRow + x);
        const value =
          opacity >= 256
            ? Math.imul(old, 255 - alpha) >>> 8
            : Math.imul(old, 65280 - Math.imul(alpha, opacity)) >>> 16;
        bitmapWrite8(target, targetRow + x, value);
      }
    }
  }
}

/** 140045dc0 tints source RGB and retains its alpha byte, even for format one. */
function tintAokanaBitmap32Pixels(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  color: number,
  opacity: number,
): void {
  const [target, input] = intersectDimensions(destination, source, false);
  writeAokanaMappedPairs(target, input, (value) => {
    let result = value & 0xff000000;
    for (let shift = 0; shift < 24; shift += 8) {
      const sourceProduct = Math.imul((value >>> shift) & 255, 256 - opacity) & 65535;
      const colorProduct = Math.imul((color >>> shift) & 255, opacity) & 65535;
      result |= (Math.min(65535, sourceProduct + colorProduct) >>> 8) << shift;
    }
    return result >>> 0;
  });
}

/** 14003a1e0, selected by 14003a2d0's format-one branch, discards alpha while attenuating RGB. */
function dimAokanaRgbPixels(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  transparency: number,
): void {
  writeAokanaMappedPairs(destination, source, (value) => {
    let result = 0;
    for (let shift = 0; shift < 24; shift += 8)
      result |= (Math.imul((value >>> shift) & 255, 256 - transparency) >>> 8) << shift;
    return result >>> 0;
  });
}

export const screenAokanaBitmap = withAokanaBitmapText(screenAokanaBitmapPixels, {
  opacity: (args) => args[2] / 256,
});

export const overlayAokanaBitmap = withAokanaBitmapText(overlayAokanaBitmapPixels, {
  opacity: (args) => args[2] / 256,
});

export const eraseAokanaAlphaFromRgb = withAokanaBitmapText(eraseAokanaAlphaFromRgbPixels, {
  source: 0,
  replace: true,
});

export const eraseAokanaAlpha = withAokanaBitmapText(eraseAokanaAlphaPixels, {
  source: 0,
  replace: true,
});

export const eraseAokanaAlphaFromMask = withAokanaBitmapText(eraseAokanaAlphaFromMaskPixels, {
  source: 0,
  replace: true,
});

export const tintAokanaBitmap32 = withAokanaBitmapText(tintAokanaBitmap32Pixels, {
  replace: true,
  color: (color, args) => {
    let output = 0;
    for (let shift = 0; shift < 24; shift += 8) {
      const from = Math.imul((color >>> shift) & 255, 256 - args[3]) & 65535,
        to = Math.imul((args[2] >>> shift) & 255, args[3]) & 65535;
      output |= (Math.min(65535, from + to) >>> 8) << shift;
    }
    return output;
  },
});

export const dimAokanaRgb = withAokanaBitmapText(dimAokanaRgbPixels, {
  replace: true,
  opacity: (args) => (256 - args[2]) / 256,
});

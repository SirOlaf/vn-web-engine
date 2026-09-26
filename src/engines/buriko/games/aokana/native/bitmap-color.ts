import {withAokanaBitmapText} from './bitmap-dom-text.js';
import type {AokanaBitmap} from './bitmap.js';
import {bitmapRead8, bitmapRead32, bitmapWrite8, bitmapWrite32} from './bitmap-scalar.js';
import {
  aokanaAlphaHalfCoefficient,
  aokanaSignedProduct16,
  readAokanaPixelPair,
  saturateAokanaByte,
  visitAokanaPixelPairs,
  writeAokanaPixelPair,
} from './bitmap-pairs.js';

/** 14003b680 and 14003acd0 share alpha-half premultiplication and saturating byte arithmetic. */
function addAokanaAlphaIntoRgbPixels(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  opacity: number,
  subtract = false,
): void {
  const pixel = (input: number, old: number): number => {
    const coefficient = opacity < 256 ? Math.imul(input >>> 25, opacity) >>> 8 : input >>> 25;
    let result = old & 0xff000000;
    for (let shift = 0; shift < 24; shift += 8) {
      const contribution = saturateAokanaByte(
        aokanaSignedProduct16((input >>> shift) & 255, coefficient) >> 7,
      );
      result |=
        saturateAokanaByte(((old >>> shift) & 255) + (subtract ? -contribution : contribution)) <<
        shift;
    }
    return result >>> 0;
  };
  visitAokanaPixelPairs(
    destination,
    source,
    (pixels, offset) => {
      if (pixels[0] >>> 24 === 0 && pixels[1] >>> 24 === 0) return;
      const old = readAokanaPixelPair(destination, offset);
      writeAokanaPixelPair(destination, offset, [
        pixel(pixels[0], old[0]),
        pixel(pixels[1], old[1]),
      ]);
    },
    (input, offset) => {
      if (input >>> 24 >= 2)
        bitmapWrite32(destination, offset, pixel(input, bitmapRead32(destination, offset)));
    },
  );
}

/** 14003b120's 0x01220000 property selects whether RGB is already premultiplied. */
function addAokanaAlphaPixels(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  opacity: number,
  nativeProperty: number,
): void {
  const premultiplied = nativeProperty === 1;
  const pixel = (input: number, old: number): number => {
    const rgbCoefficient = Math.imul(input >>> 25, opacity) >>> 8;
    const alphaCoefficient = opacity >>> 1;
    let result = 0;
    for (let shift = 0; shift < 32; shift += 8) {
      const channel = (input >>> shift) & 255;
      const contribution = premultiplied
        ? Math.imul(channel, opacity) >> 8
        : aokanaSignedProduct16(channel, shift === 24 ? alphaCoefficient : rgbCoefficient) >> 7;
      result |=
        saturateAokanaByte(((old >>> shift) & 255) + saturateAokanaByte(contribution)) << shift;
    }
    return result >>> 0;
  };
  visitAokanaPixelPairs(
    destination,
    source,
    (pixels, offset) => {
      if (pixels[0] >>> 24 === 0 && pixels[1] >>> 24 === 0) return;
      const old = readAokanaPixelPair(destination, offset);
      writeAokanaPixelPair(destination, offset, [
        pixel(pixels[0], old[0]),
        pixel(pixels[1], old[1]),
      ]);
    },
    (input, offset) => {
      if (input >>> 24 >= (premultiplied ? 1 : 2))
        bitmapWrite32(destination, offset, pixel(input, bitmapRead32(destination, offset)));
    },
  );
}

/** 14003ab50: the product is truncated after the destination multiplication. */
function multiplyAokanaRgbPixels(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  opacity: number,
): void {
  const coefficient = opacity >>> 1;
  const pixel = (input: number, old: number): number => {
    let result = old & 0xff000000;
    for (let shift = 0; shift < 24; shift += 8) {
      const target = (old >>> shift) & 255;
      const difference = aokanaSignedProduct16(((input >>> shift) & 255) - 256, coefficient);
      result |= saturateAokanaByte(target + (Math.imul(difference, target * 2) >> 16)) << shift;
    }
    return result >>> 0;
  };
  visitAokanaPixelPairs(
    destination,
    source,
    (pixels, offset) => {
      const old = readAokanaPixelPair(destination, offset);
      writeAokanaPixelPair(destination, offset, [
        pixel(pixels[0], old[0]),
        pixel(pixels[1], old[1]),
      ]);
    },
    (input, offset) =>
      bitmapWrite32(destination, offset, pixel(input, bitmapRead32(destination, offset))),
  );
}

/** 14003aa30 and 14003a500 truncate the RGB product before opacity interpolation. */
function multiplyAokanaRgbProductPixels(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  opacity: number,
  useSourceAlpha: boolean,
): void {
  const pixel = (input: number, old: number): number => {
    const coefficient = useSourceAlpha ? Math.imul(input >>> 25, opacity) >>> 8 : opacity >>> 1;
    let result = old & 0xff000000;
    for (let shift = 0; shift < 24; shift += 8) {
      const target = (old >>> shift) & 255;
      const product = Math.imul((input >>> shift) & 255, target) >>> 8;
      result |=
        saturateAokanaByte(target + (aokanaSignedProduct16(product - target, coefficient) >> 7)) <<
        shift;
    }
    return result >>> 0;
  };
  visitAokanaPixelPairs(
    destination,
    source,
    (pixels, offset) => {
      if (useSourceAlpha && pixels[0] >>> 24 === 0 && pixels[1] >>> 24 === 0) return;
      const old = readAokanaPixelPair(destination, offset);
      writeAokanaPixelPair(destination, offset, [
        pixel(pixels[0], old[0]),
        pixel(pixels[1], old[1]),
      ]);
    },
    (input, offset) => {
      if (!useSourceAlpha || input >>> 24 >= 2)
        bitmapWrite32(destination, offset, pixel(input, bitmapRead32(destination, offset)));
    },
  );
}

/** 14003a350's overlap branch is scalar; its disjoint SIMD path has the same byte results. */
function multiplyAokanaMaskPixels(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  opacity: number,
): void {
  for (let y = 0; y < source.height >>> 0; y++)
    for (let x = 0; x < source.width >>> 0; x++) {
      const targetOffset = destination.offset + y * destination.stride + x;
      const target = bitmapRead8(destination, targetOffset);
      const input = bitmapRead8(source, source.offset + y * source.stride + x);
      const product = Math.imul(Math.imul(input, target) + 1, 257) >>> 16;
      bitmapWrite8(
        destination,
        targetOffset,
        target + (Math.imul(product - target, opacity) >>> 8),
      );
    }
}

/** 14003a050 dims source RGB before blending with the promoted native alpha/2 table. */
function dimAokanaAlphaIntoRgbPixels(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  transparency: number,
): void {
  const pixel = (input: number, old: number): number => {
    const coefficient = aokanaAlphaHalfCoefficient(input >>> 24);
    let result = old & 0xff000000;
    for (let shift = 0; shift < 24; shift += 8) {
      const target = (old >>> shift) & 255;
      const dimmed = Math.imul((input >>> shift) & 255, 256 - transparency) >>> 8;
      result |=
        saturateAokanaByte(target + (aokanaSignedProduct16(dimmed - target, coefficient) >> 7)) <<
        shift;
    }
    return result >>> 0;
  };
  visitAokanaPixelPairs(
    destination,
    source,
    (pixels, offset) => {
      if (pixels[0] >>> 24 === 0 && pixels[1] >>> 24 === 0) return;
      const old = readAokanaPixelPair(destination, offset);
      writeAokanaPixelPair(destination, offset, [
        pixel(pixels[0], old[0]),
        pixel(pixels[1], old[1]),
      ]);
    },
    (input, offset) => {
      if (input >>> 24 >= 2)
        bitmapWrite32(destination, offset, pixel(input, bitmapRead32(destination, offset)));
    },
  );
}

/** 140039f00 retains normal output alpha while attenuating the source RGB coefficient. */
function dimAokanaAlphaPixels(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  transparency: number,
): void {
  for (let y = 0; y < source.height >>> 0; y++)
    for (let x = 0; x < source.width >>> 0; x++) {
      const input = source.offset + y * source.stride + x * (source.bytesPerPixel >>> 0);
      const output =
        destination.offset + y * destination.stride + x * (destination.bytesPerPixel >>> 0);
      const sourcePixel = bitmapRead32(source, input);
      const alpha = sourcePixel >>> 24;
      if (alpha === 0) continue;
      const destinationAlpha = Math.imul(256 - alpha, bitmapRead8(destination, output + 3));
      const denominator = ((alpha << 8) + destinationAlpha) >>> 0;
      const sourceCoefficient = Math.trunc(
        ((Math.imul(alpha, 256 - transparency) << 16) >>> 0) / denominator,
      );
      const destinationCoefficient = Math.trunc(((destinationAlpha << 16) >>> 0) / denominator);
      const blue =
        Math.imul(sourcePixel & 255, sourceCoefficient) +
        Math.imul(bitmapRead8(destination, output), destinationCoefficient);
      const destinationGreen = Math.imul(
        bitmapRead8(destination, output + 1),
        destinationCoefficient,
      );
      const destinationRed = bitmapRead8(destination, output + 2);
      bitmapWrite8(destination, output, blue >>> 16);
      const green = Math.imul(bitmapRead8(source, input + 1), sourceCoefficient) + destinationGreen;
      bitmapWrite8(destination, output + 1, green >>> 16);
      const red =
        Math.imul(bitmapRead8(source, input + 2), sourceCoefficient) +
        Math.imul(destinationRed, destinationCoefficient);
      bitmapWrite8(destination, output + 3, denominator >>> 8);
      bitmapWrite8(destination, output + 2, red >>> 16);
    }
}

export const addAokanaAlphaIntoRgb = withAokanaBitmapText(addAokanaAlphaIntoRgbPixels, {
  opacity: (args) => args[2] / 256,
});

export const addAokanaAlpha = withAokanaBitmapText(addAokanaAlphaPixels, {
  opacity: (args) => args[2] / 256,
});

export const multiplyAokanaRgb = withAokanaBitmapText(multiplyAokanaRgbPixels, {
  opacity: (args) => args[2] / 256,
});

export const multiplyAokanaRgbProduct = withAokanaBitmapText(multiplyAokanaRgbProductPixels, {
  opacity: (args) => args[2] / 256,
});

export const multiplyAokanaMask = withAokanaBitmapText(multiplyAokanaMaskPixels, {
  opacity: (args) => args[2] / 256,
});

export const dimAokanaAlphaIntoRgb = withAokanaBitmapText(dimAokanaAlphaIntoRgbPixels, {
  opacity: (args) => (256 - args[2]) / 256,
});

export const dimAokanaAlpha = withAokanaBitmapText(dimAokanaAlphaPixels, {
  opacity: (args) => (256 - args[2]) / 256,
});

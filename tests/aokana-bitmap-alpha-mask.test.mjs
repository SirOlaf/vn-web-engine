import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBitmapStorage} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {
  applyAokanaAlphaMask,
  applyAokanaBitmapMask,
} from '../dist/engines/buriko/games/aokana/native/bitmap-alpha-mask.js';

function bitmap(width, height, values, format = 2, padding = 4) {
  const bytesPerPixel = format === 3 ? 1 : 4;
  const stride = width * bytesPerPixel + padding;
  const bytes = new Uint8Array(stride * height).fill(0xa5);
  const view = new DataView(bytes.buffer);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const value = values[y * width + x] ?? 0;
      if (format === 3) bytes[y * stride + x] = value;
      else view.setUint32(y * stride + x * 4, value, true);
    }
  return {
    storage: new AokanaBitmapStorage(bytes, true),
    offset: 0,
    stride,
    width,
    height,
    format,
    bytesPerPixel,
  };
}
function pixels(bitmap) {
  return Array.from({length: bitmap.height}, (_, y) =>
    Array.from({length: bitmap.width}, (_, x) =>
      bitmap.format === 3
        ? bitmap.storage.bytes[bitmap.offset + y * bitmap.stride + x]
        : bitmap.storage.view.getUint32(bitmap.offset + y * bitmap.stride + x * 4, true),
    ),
  ).flat();
}
const alphaValues = [0, 64, 128, 192, 254, 255, 100];
const maskValues = [255, 128, 192, 255, 100, 200, 128];
const sourcePixels = alphaValues.map((alpha, index) => ((alpha << 24) | (0x10203 + index)) >>> 0);
const rgbaMask = () =>
  bitmap(
    7,
    1,
    maskValues.map((alpha) => ((alpha << 24) | 0xabcdef) >>> 0),
  );

test('RGBA mask supplies RGB alpha across four, two, and one-pixel groups', () => {
  const source = bitmap(7, 1, sourcePixels, 1, 8);
  const destination = bitmap(7, 2, Array(14).fill(0x11223344));
  assert.equal(applyAokanaAlphaMask(destination, source, rgbaMask(), 128), 0);
  const expected = sourcePixels.map(
    (pixel, index) => ((pixel & 0xffffff) | (Math.floor(maskValues[index] / 2) << 24)) >>> 0,
  );
  assert.deepEqual(pixels(destination), [...expected, ...Array(7).fill(0x11223344)]);
  assert.deepEqual(Array.from(destination.storage.bytes.slice(28, 32)), [165, 165, 165, 165]);
});

test('RGBA mask multiplies source alpha through separate and same-pointer descriptors', () => {
  const source = bitmap(7, 1, sourcePixels);
  const destination = bitmap(7, 1, Array(7).fill(0));
  const expected = sourcePixels.map(
    (pixel, index) =>
      ((pixel & 0xffffff) |
        (Math.floor((alphaValues[index] * maskValues[index] * 128) / 65536) << 24)) >>>
      0,
  );
  assert.equal(applyAokanaAlphaMask(destination, source, rgbaMask(), 128), 0);
  assert.deepEqual(pixels(destination), expected);
  const inPlace = bitmap(7, 1, sourcePixels);
  assert.equal(applyAokanaAlphaMask(inPlace, {...inPlace}, rgbaMask(), 128), 0);
  assert.deepEqual(pixels(inPlace), expected);
});

test('one-byte masks preserve the distinct RGB, RGBA, and byte product conventions', () => {
  const mask = bitmap(7, 1, maskValues, 3, 3);
  const rgbDestination = bitmap(7, 1, Array(7).fill(0));
  assert.equal(applyAokanaBitmapMask(rgbDestination, bitmap(7, 1, sourcePixels, 1), mask), 0);
  assert.deepEqual(
    pixels(rgbDestination),
    sourcePixels.map((pixel, index) => ((pixel & 0xffffff) | (maskValues[index] << 24)) >>> 0),
  );
  const alphaDestination = bitmap(7, 1, Array(7).fill(0));
  assert.equal(applyAokanaBitmapMask(alphaDestination, bitmap(7, 1, sourcePixels), mask), 0);
  assert.deepEqual(
    pixels(alphaDestination),
    sourcePixels.map(
      (pixel, index) =>
        ((pixel & 0xffffff) |
          (Math.floor((alphaValues[index] * maskValues[index]) / 256) << 24)) >>>
        0,
    ),
  );
  const byteDestination = bitmap(7, 1, Array(7).fill(0), 3, 3);
  assert.equal(applyAokanaBitmapMask(byteDestination, bitmap(7, 1, alphaValues, 3), mask), 0);
  assert.deepEqual(
    pixels(byteDestination),
    alphaValues.map((value, index) => Math.floor((value * (maskValues[index] + 1)) / 256)),
  );
  assert.deepEqual(Array.from(byteDestination.storage.bytes.slice(7)), [165, 165, 165]);
});

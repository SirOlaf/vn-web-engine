import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBitmapStorage} from '../dist/engines/buriko/native/bitmap.js';
import {
  blendBurikoAlphaIntoRgb,
  blendBurikoAlphaIntoRgbWithTransparency,
} from '../dist/engines/buriko/native/bitmap-alpha.js';

function random(seed, length) {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    bytes[i] = seed;
  }
  // Alpha bytes cover skipped, opaque-pair and blended pixels.
  const alphas = [0, 0, 1, 2, 128, 253, 254, 255];
  for (let i = 3; i < length; i += 4) bytes[i] = alphas[bytes[i] & 7];
  return bytes;
}

function bitmap(bytes, offset, stride, width, height, format) {
  return {
    storage: new BurikoBitmapStorage(bytes, true),
    offset,
    stride,
    width,
    height,
    format,
    bytesPerPixel: 4,
  };
}

function packedRows(bytes, offset, stride, width, height) {
  const packed = new Uint8Array(width * 4 * height);
  for (let row = 0; row < height; row++)
    packed.set(
      bytes.subarray(offset + row * stride, offset + row * stride + width * 4),
      row * width * 4,
    );
  return packed;
}

function blend(destination, source, transparency) {
  if (transparency === null) blendBurikoAlphaIntoRgb(destination, source);
  else blendBurikoAlphaIntoRgbWithTransparency(destination, source, transparency);
}

test('padded RGB alpha blending matches packed rows for span and row staging', () => {
  // Padding within twice the packed rows stages one pitched span; wider pitches stage rows.
  for (const [width, height, sourcePadding, destinationPadding, offset] of [
    [200, 24, 16, 0, 0],
    [161, 13, 12, 36, 8],
    [130, 10, 600, 4, 4],
    [257, 7, 0, 2000, 12],
  ])
    for (const transparency of [null, 0, 77, 256]) {
      const sourceStride = width * 4 + sourcePadding,
        destinationStride = width * 4 + destinationPadding,
        sourceBytes = random(7, offset + sourceStride * height),
        destinationBytes = random(11, offset + destinationStride * height);
      const packedDestination = bitmap(
        packedRows(destinationBytes, offset, destinationStride, width, height),
        0,
        width * 4,
        width,
        height,
        1,
      );
      blend(
        packedDestination,
        bitmap(
          packedRows(sourceBytes, offset, sourceStride, width, height),
          0,
          width * 4,
          width,
          height,
          2,
        ),
        transparency,
      );
      const padded = bitmap(destinationBytes.slice(), offset, destinationStride, width, height, 1);
      blend(padded, bitmap(sourceBytes, offset, sourceStride, width, height, 2), transparency);
      // Rows match the packed blend; bytes outside them keep their original values.
      const expected = destinationBytes.slice();
      for (let row = 0; row < height; row++)
        expected.set(
          packedDestination.storage.bytes.subarray(row * width * 4, (row + 1) * width * 4),
          offset + row * destinationStride,
        );
      assert.deepEqual(
        padded.storage.bytes,
        expected,
        JSON.stringify({width, sourcePadding, destinationPadding, transparency}),
      );
    }
});

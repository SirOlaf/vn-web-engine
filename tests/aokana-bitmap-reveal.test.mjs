import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBitmapStorage} from '../dist/engines/buriko/native/bitmap.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {
  revealBurikoBitmap,
  blendRevealedBurikoBitmap,
} from '../dist/engines/buriko/native/bitmap-reveal.js';

function bitmap(width, height, values, format = 2) {
  const bytesPerPixel = format === 3 ? 1 : 4;
  const stride = width * bytesPerPixel + 4;
  const bytes = new Uint8Array(stride * height).fill(0xa5);
  const view = new DataView(bytes.buffer);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (format === 3) bytes[y * stride + x] = values[y * width + x] ?? 0;
      else view.setUint32(y * stride + x * 4, values[y * width + x] ?? 0, true);
    }
  return {
    storage: new BurikoBitmapStorage(bytes, true),
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
      bitmap.storage.view.getUint32(y * bitmap.stride + x * 4, true),
    ),
  ).flat();
}
const mask = () => bitmap(7, 1, [0, 32, 64, 96, 128, 192, 255], 3);

test('mask reveal retains the 255 ramp ceiling in four-pixel and scalar groups', () => {
  const compositor = new BurikoBitmapCompositor();
  for (const format of [1, 2]) {
    const source = bitmap(7, 1, Array(7).fill(0x80123456), format);
    const output = bitmap(7, 1, Array(7).fill(0));
    revealBurikoBitmap(compositor, output, source, mask(), 2, 64);
    const alphas = format === 1 ? [255, 192, 64, 0, 0, 0, 0] : [127, 96, 32, 0, 0, 0, 0];
    assert.deepEqual(
      pixels(output),
      alphas.map((alpha) => ((alpha << 24) | 0x123456) >>> 0),
    );
    assert.deepEqual(Array.from(output.storage.bytes.slice(28)), [165, 165, 165, 165]);
  }
});

test('mask reveal clear and copy endpoints use the existing concrete bitmap operations', () => {
  const compositor = new BurikoBitmapCompositor();
  const source = bitmap(7, 1, Array(7).fill(0x00123456), 1);
  const output = bitmap(7, 1, Array(7).fill(0x55123456));
  revealBurikoBitmap(compositor, output, source, mask(), 2, 0);
  assert.deepEqual(pixels(output), Array(7).fill(0));
  revealBurikoBitmap(compositor, output, source, mask(), 2, 256);
  assert.deepEqual(pixels(output), Array(7).fill(0xff123456));
});

test('direct RGB reveal retains the 129-entry blend table and source alpha quantization', () => {
  const compositor = new BurikoBitmapCompositor();
  for (const format of [1, 2]) {
    const source = bitmap(7, 1, Array(7).fill(0x80f0f0f0), format);
    const output = bitmap(7, 1, Array(7).fill(0x05101010), 1);
    blendRevealedBurikoBitmap(compositor, output, source, mask(), 2, 64, 64);
    const components =
      format === 1 ? [184, 142, 58, 16, 16, 16, 16] : [100, 79, 37, 16, 16, 16, 16];
    assert.deepEqual(
      pixels(output),
      components.map((value) => (0x05000000 | (value << 16) | (value << 8) | value) >>> 0),
    );
    assert.deepEqual(Array.from(output.storage.bytes.slice(28)), [165, 165, 165, 165]);
  }
});

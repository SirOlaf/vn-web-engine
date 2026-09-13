import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBitmapStorage} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {applyAokanaBitmapColorEffect} from '../dist/engines/buriko/games/aokana/native/bitmap-color-effects.js';
import {AokanaSpriteEffects} from '../dist/engines/buriko/games/aokana/native/sprite-effects.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';

function bitmap(width, height, values, format = 2) {
  const stride = width * 4 + 4;
  const bytes = new Uint8Array(stride * height).fill(0xa5);
  const view = new DataView(bytes.buffer);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      view.setUint32(y * stride + x * 4, values[y * width + x] ?? 0, true);
  return {
    storage: new AokanaBitmapStorage(bytes, true),
    offset: 0,
    stride,
    width,
    height,
    format,
    bytesPerPixel: 4,
  };
}
function pixels(bitmap) {
  return Array.from({length: bitmap.height}, (_, y) =>
    Array.from({length: bitmap.width}, (_, x) =>
      bitmap.storage.view.getUint32(y * bitmap.stride + x * 4, true),
    ),
  ).flat();
}
const values = [0x00102030, 0x00405060, 0x00123456, 0x80abcdef, 0x01224466, 0xff447799, 0x00112233];

test('XOR and luminance effects retain Q7 rounding and RGBA pair coverage', () => {
  const compositor = new AokanaBitmapCompositor();
  const expected = [
    [0x00ed2e64, 0x00be5e35, 0x00eb3a03, 0x8054c2ba, 0x01db4a33, 0xffba77cb, 0x00ec2c65],
    [0x001b0109, 0x004b0419, 0x002c020f, 0x80c40c42, 0x013c0314, 0xff6a0623, 0x001d010a],
  ];
  for (const selector of [1, 2]) {
    for (const format of [1, 2]) {
      const output = bitmap(7, 1, Array(7).fill(0), format);
      assert.equal(
        applyAokanaBitmapColorEffect(
          compositor,
          output,
          bitmap(7, 1, values, format),
          selector,
          0x00ff0f55,
          255,
        ),
        0,
      );
      assert.deepEqual(
        pixels(output),
        expected[selector - 1].map((value, index) =>
          format === 2 && (index < 2 || index === 6) ? 0 : value,
        ),
      );
      assert.deepEqual(Array.from(output.storage.bytes.slice(28)), [165, 165, 165, 165]);
    }
  }
});

test('color addition preserves alpha while subtraction applies its fourth color byte', () => {
  const compositor = new AokanaBitmapCompositor();
  const input = [
    0x10000000, 0x20506070, 0x30f0f0f0, 0x80ffffff, 0xff102030, 0x00112233, 0x99887766,
  ];
  for (const selector of [4, 5]) {
    const output = bitmap(7, 1, Array(7).fill(0));
    applyAokanaBitmapColorEffect(
      compositor,
      output,
      bitmap(7, 1, input),
      selector,
      0x8020f080,
      128,
    );
    const offsets = selector === 4 ? [64, 120, 16, 0] : [64, 120, 16, 64];
    const expected = input.map((pixel) => {
      const bytes = Array.from({length: 4}, (_, index) => {
        const value = (pixel >>> (index * 8)) & 255;
        return selector === 4
          ? Math.min(255, value + offsets[index])
          : Math.max(0, value - offsets[index]);
      });
      return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
    });
    assert.deepEqual(pixels(output), expected);
  }
});

test('copy and tint selectors call the shared concrete conversion and dimming paths', () => {
  const compositor = new AokanaBitmapCompositor();
  const source = bitmap(3, 1, [0x00102030, 0x00406080, 0x0080a0c0], 1);
  const output = bitmap(3, 1, Array(3).fill(0), 2);
  applyAokanaBitmapColorEffect(compositor, output, source, 0, 0x112233, 27);
  assert.deepEqual(pixels(output), [0xff102030, 0xff406080, 0xff80a0c0]);
  const tinted = bitmap(3, 1, Array(3).fill(0), 1);
  applyAokanaBitmapColorEffect(compositor, tinted, source, 3, 0x204060, 128);
  assert.deepEqual(pixels(tinted), [0x00183048, 0x00305070, 0x00507090]);
  applyAokanaBitmapColorEffect(compositor, tinted, source, 3, 0, 128);
  assert.deepEqual(pixels(tinted), [0x00081018, 0x00203040, 0x00405060]);
});

test('sprite effect records use the optional source once and preserve slot order', () => {
  const effects = new AokanaSpriteEffects(new AokanaBitmapCompositor());
  const output = bitmap(1, 1, [0x80606060]);
  assert.equal(effects.active, false);
  assert.equal(effects.apply(output), 0);
  assert.equal(effects.set(2, 4, 0x20, 256), 0);
  assert.equal(effects.set(15, 1, 0xff, 256), 0);
  assert.equal(effects.active, true);
  assert.equal(effects.apply(output, bitmap(1, 1, [0x80010203])), 1);
  assert.deepEqual(pixels(output), [0x800102dc]);
});

test('all color effect selectors share the actual distributed bitmap job owner', () => {
  const processing = new AokanaDistributedProcessing(new AokanaDistributedAllocator(3), 3);
  const compositor = new AokanaBitmapCompositor();
  compositor.processing = processing;
  const source = bitmap(
    65,
    101,
    Array.from({length: 65 * 101}, (_, index) => (0x80000000 | (index * 499)) >>> 0),
  );
  for (let selector = 0; selector < 6; selector++) {
    const serial = bitmap(65, 101, []),
      parallel = bitmap(65, 101, []);
    applyAokanaBitmapColorEffect(compositor, serial, source, selector, 0x123456, 127);
    applyAokanaBitmapColorEffect(compositor, parallel, source, selector, 0x123456, 127, true);
    assert.deepEqual(parallel.storage.bytes, serial.storage.bytes);
  }
  assert.equal(compositor.processing, processing);
});

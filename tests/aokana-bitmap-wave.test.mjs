import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBitmapStorage} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {waveAokanaBitmap} from '../dist/engines/buriko/games/aokana/native/bitmap-wave.js';
import {aokanaBitmapOperationScalars} from '../dist/engines/buriko/games/aokana/native/bitmap-operation-jobs.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';

const gray = (value) => Math.imul(value, 0x1010101) >>> 0;
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
  );
}

test('wave centers differing widths and advances Q4 row interpolation without changing padding', () => {
  const sourceRow = [10, 30, 50, 70, 90].map(gray);
  const expected = [
    [0, 10, 30, 50, 70, 90, 0],
    [6, 22, 42, 62, 82, 33, 0],
    [0, 10, 30, 50, 70, 90, 0],
    [18, 18, 18, 18, 18, 18, 18],
  ].map((row) => row.map(gray));
  for (const format of [1, 2]) {
    const source = bitmap(5, 3, [...sourceRow, ...sourceRow, ...sourceRow], format);
    const output = bitmap(7, 4, Array(28).fill(gray(18)), format);
    waveAokanaBitmap(new AokanaBitmapCompositor(), output, source, 4, 0, 16384);
    assert.deepEqual(pixels(output), expected);
    for (let row = 0; row < 4; row++)
      assert.deepEqual(
        Array.from(output.storage.bytes.slice(row * output.stride + 28, (row + 1) * output.stride)),
        [165, 165, 165, 165],
      );
  }
});

test('wave negative phase retains signed displacement in pair and odd-tail pixels', () => {
  const output = bitmap(5, 1, Array(5).fill(0));
  const source = bitmap(5, 1, [10, 30, 50, 70, 90].map(gray));
  waveAokanaBitmap(new AokanaBitmapCompositor(), output, source, 4, -1, 16384);
  assert.deepEqual(pixels(output), [[3, 17, 37, 57, 77].map(gray)]);
  const evenOutput = bitmap(8, 1, Array(8).fill(0));
  const evenSource = bitmap(8, 1, [10, 20, 30, 40, 50, 60, 70, 80].map(gray));
  waveAokanaBitmap(new AokanaBitmapCompositor(), evenOutput, evenSource, 4, -1, 32768);
  assert.deepEqual(pixels(evenOutput), [[0, 0, 10, 20, 30, 40, 50, 60].map(gray)]);
});

test('wave strips preserve scalar row offsets, signed phase wrapping, and the actual shared pool', () => {
  const plan = {count: 3, increment: Math.floor((101 * 65536) / 3)};
  assert.deepEqual(aokanaBitmapOperationScalars(0, plan), [0, 33, 67]);
  assert.deepEqual(aokanaBitmapOperationScalars(-8, plan), [-8, 25, 59]);
  const processing = new AokanaDistributedProcessing(new AokanaDistributedAllocator(3), 3);
  const compositor = new AokanaBitmapCompositor();
  compositor.processing = processing;
  const source = bitmap(
    65,
    101,
    Array.from({length: 65 * 101}, (_, index) => gray((index * 13) & 255)),
  );
  const serial = bitmap(69, 101, []),
    parallel = bitmap(69, 101, []);
  waveAokanaBitmap(compositor, serial, source, 79, 0x7fffffd0, 1024);
  waveAokanaBitmap(compositor, parallel, source, 79, 0x7fffffd0, 1024, true);
  assert.deepEqual(parallel.storage.bytes, serial.storage.bytes);
  assert.equal(compositor.processing, processing);
});

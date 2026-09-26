import test from 'node:test';
import assert from 'node:assert/strict';
import {allocateBurikoBitmap, fillBurikoBitmap} from '../dist/engines/buriko/native/bitmap.js';
import {bitmapRead32, bitmapWrite32} from '../dist/engines/buriko/native/bitmap-scalar.js';
import {mixBurikoBitmaps} from '../dist/engines/buriko/native/bitmap-mix.js';
import {
  burikoBitmapStripPlan,
  burikoBitmapOperationStrips,
} from '../dist/engines/buriko/native/bitmap-operation-jobs.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';

function bitmap(format, pixels) {
  const result = allocateBurikoBitmap(pixels.length, 1, format);
  pixels.forEach((value, i) => bitmapWrite32(result, i * 4, value));
  return result;
}
function pixels(bitmap) {
  return Array.from({length: bitmap.width}, (_, i) => bitmapRead32(bitmap, i * 4));
}

test('native RGB mixing interpolates all bytes with arithmetic flooring in pair and tail paths', () => {
  const a = bitmap(1, [0x003b829d, 0x007ffa13, 0x00337799]);
  const b = bitmap(1, [0x006bfc2c, 0x0089bdec, 0x00115588]);
  const output = allocateBurikoBitmap(3, 1, 1);
  for (const factor of [0, 1, 63, 128, 201, 256]) {
    assert.equal(mixBurikoBitmaps(output, a, b, factor), 0);
    const expected = pixels(a).map((first, index) => {
      const second = pixels(b)[index];
      let pixel = 0;
      for (let shift = 0; shift < 32; shift += 8)
        pixel |=
          Math.floor(
            (((first >>> shift) & 255) * (256 - factor) + ((second >>> shift) & 255) * factor) /
              256,
          ) << shift;
      return pixel >>> 0;
    });
    assert.deepEqual(pixels(output), expected);
  }
});

test('native alpha mixing weights colors by coverage and retains reciprocal-table quantization', () => {
  const a = bitmap(2, [0xfffefcf8, 0x400a0c0e, 0x00ffffff]);
  const b = bitmap(2, [0xff000000, 0xc0a0a0a0, 0x00012345]);
  const output = allocateBurikoBitmap(3, 1, 2);
  assert.equal(mixBurikoBitmaps(output, a, b, 128), 0);
  const result = pixels(output);
  assert.deepEqual(
    result.map((value) => value >>> 24),
    [255, 128, 0],
  );
  // Native RCPPS is approximate: the half coefficient is 63/128 and the quarter is31/128.
  assert.equal(result[0], 0xff7d7c7a);
  assert.equal(result[1], 0x807b7c7c);
  assert.equal(result[2], 0x00012345);
});

test('bitmap operation strips use actual worker capacity and complete every normal draw job', () => {
  const processing = new BurikoDistributedProcessing(new BurikoDistributedAllocator(3), 3);
  const first = allocateBurikoBitmap(65, 101, 1),
    second = allocateBurikoBitmap(65, 101, 1);
  const output = allocateBurikoBitmap(65, 101, 1);
  fillBurikoBitmap(first, 0x00102030);
  fillBurikoBitmap(second, 0x00b08060);
  const plan = burikoBitmapStripPlan(processing, first, 0);
  assert.deepEqual(plan, {count: 3, increment: Math.floor((101 * 65536) / 3)});
  const strips = burikoBitmapOperationStrips([first, second, output], plan, 0);
  assert.deepEqual(
    strips.map((job) => job[0].height),
    [33, 34, 34],
  );
  assert.deepEqual(
    strips.map((job) => job[0].offset),
    [0, 33 * 260, 67 * 260],
  );
  assert.equal(mixBurikoBitmaps(output, first, second, 128, processing), 0);
  for (let row = 0; row < 101; row++)
    for (let column = 0; column < 65; column++)
      assert.equal(bitmapRead32(output, row * output.stride + column * 4), 0x00605048);
});

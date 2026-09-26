import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBitmapStorage} from '../dist/engines/buriko/native/bitmap.js';
import {scaleBurikoBitmap} from '../dist/engines/buriko/native/bitmap-scale.js';

function bitmap(width, height, pixels, format = 2) {
  const bytes = new Uint8Array(new Uint32Array(pixels).buffer);
  return {
    width,
    height,
    storage: new BurikoBitmapStorage(bytes, true),
    offset: 0,
    stride: width * 4,
    bytesPerPixel: 4,
    format,
  };
}
const output = (width, height) => bitmap(width, height, Array(width * height).fill(0x98765432));
const words = (bitmap) => [...new Uint32Array(bitmap.storage.bytes.buffer)];

test('native bilinear scaling uses its endpoint spacing and independent RGBA channels', () => {
  const source = bitmap(2, 2, [0xff000000, 0xff000040, 0xff004000, 0xff004040]);
  const enlarged = output(4, 4);
  scaleBurikoBitmap(enlarged, source, 0x20000);
  assert.deepEqual(
    words(enlarged),
    Array.from(
      {length: 16},
      (_, index) => (0xff000000 | ((Math.floor(index / 4) * 16) << 8) | ((index % 4) * 16)) >>> 0,
    ),
  );
  const sameSize = output(2, 2);
  scaleBurikoBitmap(sameSize, source, 0x10000);
  assert.deepEqual(words(sameSize), [0xff000000, 0xff000020, 0xff002000, 0xff002020]);
  const cropped = output(2, 2);
  scaleBurikoBitmap(cropped, source, 0x20000);
  assert.deepEqual(words(cropped), [0xff001010, 0xff001020, 0xff002010, 0xff002020]);
});

test('native weighted shrinking retains coverage-table quantization and centering', () => {
  const pixels = Array.from(
    {length: 16},
    (_, index) => (0xff000000 | (Math.floor(index / 4) * 10 + (index % 4))) >>> 0,
  );
  const source = bitmap(4, 4, pixels),
    half = output(2, 2),
    threeQuarters = output(3, 3);
  scaleBurikoBitmap(half, source, 0x8000);
  assert.deepEqual(
    words(half),
    [16, 17, 26, 27].map((value) => (0xff000000 | value) >>> 0),
  );
  scaleBurikoBitmap(threeQuarters, source, 0xc000);
  // The four Q8 coverage-table entries are 16,48,48,143: their sum is255.
  assert.deepEqual(
    words(threeQuarters),
    [8, 9, 10, 18, 19, 20, 28, 29, 30].map((value) => (0xfe000000 | value) >>> 0),
  );
});

test('native integer shrinking excludes transparent RGB but averages alpha over the whole box', () => {
  const pixels = Array.from({length: 64}, (_, i) =>
    ((i % 8) + Math.floor(i / 8)) % 2 === 0 ? 0xff0000c8 : 10,
  );
  const source = bitmap(8, 8, pixels),
    destination = output(2, 2);
  scaleBurikoBitmap(destination, source, 0x4000);
  assert.deepEqual(words(destination), Array(4).fill(0x7f0000c8));
  source.format = 1;
  scaleBurikoBitmap(destination, source, 0x4000);
  assert.deepEqual(words(destination), Array(4).fill(0x7f000069));
});

test('centered native scaling preserves destination pixels outside the scaled rectangle', () => {
  const source = bitmap(2, 2, Array(4).fill(0xff123456)),
    destination = output(6, 6);
  scaleBurikoBitmap(destination, source, 0x20000);
  assert.deepEqual(
    words(destination),
    Array.from({length: 36}, (_, index) => {
      const x = index % 6,
        y = Math.floor(index / 6);
      return x >= 1 && x <= 4 && y >= 1 && y <= 4 ? 0xff123456 : 0x98765432;
    }),
  );
});

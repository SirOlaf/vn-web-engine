import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBitmapStorage} from '../dist/engines/buriko/native/bitmap.js';
import {reduceBurikoBitmapHalf} from '../dist/engines/buriko/native/bitmap-reduce.js';

function bitmap(width, height, values, format = 2) {
  const bytes = new Uint8Array(width * height * 4);
  for (let i = 0; i < values.length; i++)
    for (let channel = 0; channel < 4; channel++) bytes[i * 4 + channel] = values[i] + channel;
  return {
    storage: new BurikoBitmapStorage(bytes, true),
    offset: 0,
    stride: width * 4,
    width,
    height,
    format,
    bytesPerPixel: 4,
  };
}

test('half reduction preserves vertical-then-horizontal byte rounding and odd edges', () => {
  const source = bitmap(3, 3, [0, 0, 20, 1, 3, 21, 40, 43, 99]);
  const destination = bitmap(3, 3, Array(9).fill(200));
  reduceBurikoBitmapHalf(destination, source);
  const expected = bitmap(3, 3, [2, 21, 200, 42, 99, 200, 200, 200, 200]);
  assert.deepEqual(destination.storage.bytes, expected.storage.bytes);
});

test('half reduction honors a smaller destination and includes the RGB fourth byte', () => {
  const source = bitmap(5, 2, [0, 0, 10, 14, 30, 1, 3, 13, 17, 33], 1);
  const destination = bitmap(2, 1, [200, 200], 1);
  reduceBurikoBitmapHalf(destination, source);
  assert.deepEqual(destination.storage.bytes, bitmap(2, 1, [2, 14], 1).storage.bytes);
});

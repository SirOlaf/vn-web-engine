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

const descriptor = (storage, width, height, stride, offset = 0) => ({
  storage,
  offset,
  stride,
  width,
  height,
  format: 2,
  bytesPerPixel: 4,
});
const pattern = (size) => Uint8Array.from({length: size}, (_, index) => (index * 73 + 129) & 255);

test('checked reduction retains stride, pair aliasing, odd-edge and destination validity behavior', () => {
  for (const [sourceStride, sourceOffset, destinationStride, destinationOffset, alias] of [
    [40, 4, 24, 8, false],
    [40, 4, 24, 8, true],
    [40, 4, 24, 20, true],
    [40, 4, -24, 80, true],
    [-40, 164, 24, 8, true],
  ]) {
    const create = (scalar) => {
      const bytes = pattern(256),
        // Imported per-byte validity has no initialized-prefix proof, retaining scalar checks.
        sourceStorage = scalar
          ? BurikoBitmapStorage.tracked(bytes, new Uint8Array(bytes.length).fill(1))
          : new BurikoBitmapStorage(bytes, true),
        destinationStorage = alias
          ? sourceStorage
          : new BurikoBitmapStorage(new Uint8Array(128).fill(0xcc), false);
      return {
        source: descriptor(sourceStorage, 9, 5, sourceStride, sourceOffset),
        destination: descriptor(destinationStorage, 6, 4, destinationStride, destinationOffset),
      };
    };
    const checked = create(false),
      scalar = create(true);
    reduceBurikoBitmapHalf(checked.destination, checked.source);
    reduceBurikoBitmapHalf(scalar.destination, scalar.source);
    assert.deepEqual(checked.destination.storage.bytes, scalar.destination.storage.bytes);
    assert.deepEqual(
      checked.destination.storage.initializedRange(0, checked.destination.storage.bytes.length),
      scalar.destination.storage.initializedRange(0, scalar.destination.storage.bytes.length),
    );
    if (!alias) {
      const initialized = new Uint8Array(128);
      for (let row = 0; row < 3; row++) initialized.fill(1, 8 + row * 24, 28 + row * 24);
      assert.deepEqual(checked.destination.storage.initializedRange(0, 128), initialized);
      assert.equal(checked.destination.storage.bytes[28], 0xcc, 'row padding remains untouched');
    }
  }
});

test('reduction keeps scalar fault order and partial initialization for sparse or malformed spans', () => {
  const validity = new Uint8Array(64).fill(1);
  validity[20] = 0;
  const sparse = descriptor(BurikoBitmapStorage.tracked(pattern(64), validity), 8, 2, 32),
    destination = descriptor(new BurikoBitmapStorage(new Uint8Array(16), false), 4, 1, 16);
  assert.throws(() => reduceBurikoBitmapHalf(destination, sparse), /unwritten native allocation/);
  assert.deepEqual(
    destination.storage.initializedRange(0, 16),
    Uint8Array.from({length: 16}, (_, index) => Number(index < 8)),
    'both pixels from the first pair commit before a later source fault',
  );

  const source = descriptor(new BurikoBitmapStorage(pattern(64), true), 8, 2, 32),
    short = descriptor(new BurikoBitmapStorage(new Uint8Array(12), false), 4, 1, 16);
  assert.throws(() => reduceBurikoBitmapHalf(short, source), /outside native allocation/);
  assert.deepEqual(short.storage.initializedRange(0, 12), new Uint8Array(12).fill(1));
  const complete = descriptor(new BurikoBitmapStorage(new Uint8Array(16), false), 4, 1, 16);
  reduceBurikoBitmapHalf(complete, source);
  assert.deepEqual(short.storage.bytes, complete.storage.bytes.subarray(0, 12));
  assert.deepEqual(destination.storage.bytes.subarray(0, 8), complete.storage.bytes.subarray(0, 8));
  source.storage.release();
  assert.throws(() => reduceBurikoBitmapHalf(complete, source), /released native allocation/);
});

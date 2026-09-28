import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBitmapStorage} from '../dist/engines/buriko/native/bitmap.js';
import {transitionBurikoBitmap} from '../dist/engines/buriko/native/bitmap-transition.js';

function random(seed, length) {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    bytes[i] = seed;
  }
  return bytes;
}

// Tracked validity maps defeat the initialized-prefix proof, retaining checked scalar access.
function storages(bytes, initialized = new Uint8Array(bytes.length).fill(1)) {
  const fast = new BurikoBitmapStorage(bytes.slice(), false);
  for (let offset = 0; offset < bytes.length; offset++)
    if (initialized[offset] !== 0) fast.written(offset, 1);
  return [fast, BurikoBitmapStorage.tracked(bytes.slice(), initialized)];
}

function descriptor(storage, offset, width, height, stride, format) {
  return {storage, offset, stride, width, height, format, bytesPerPixel: format === 3 ? 1 : 4};
}

function transitionBoth(width, height, padding, shared, parameters, initialized) {
  const stride = width * 4 + padding,
    pixels = stride * height;
  // Shared storage overlaps the destination one pixel after its source.
  const outputs = storages(random(1, shared ? pixels + 4 : pixels), initialized),
    inputs = shared ? outputs : storages(random(2, pixels));
  const masks = storages(random(3, (width + padding) * height));
  const results = [0, 1].map((index) => {
    const destination = descriptor(outputs[index], shared ? 4 : 0, width, height, stride, 1),
      source = descriptor(inputs[index], 0, width, height, stride, 1),
      mask = descriptor(masks[index], 0, width, height, width + padding, 3);
    let error = null;
    try {
      transitionBurikoBitmap(destination, 0, 0, source, mask, ...parameters, false);
    } catch (thrown) {
      error = thrown.message;
    }
    const storage = outputs[index];
    return {error, bytes: storage.bytes, valid: storage.initializedRange(0, storage.bytes.length)};
  });
  assert.deepEqual(results[0], results[1], JSON.stringify({width, padding, shared, parameters}));
  return results[0];
}

test('masked RGB transitions agree with checked traversal across coefficient modes and storage', () => {
  // [parameter, blend, extra]: Q7 small steps, small ramps, triangle tables, and saturation.
  for (const parameters of [
    [0, 128, 0],
    [3, 77, 0],
    [7, 256, 0],
    [2, 40, 9],
    [9, 128, 0],
    [100, 10, 300],
    [0xffffffff, 256, 5],
  ])
    for (const [width, height, padding] of [
      [160, 12, 0],
      [131, 9, 12],
      [37, 5, 3],
    ])
      for (const shared of [false, true])
        assert.equal(transitionBoth(width, height, padding, shared, parameters).error, null);
});

test('masked RGB transitions keep completed stores before an unwritten destination fault', () => {
  const width = 160,
    height = 12,
    initialized = new Uint8Array(width * 4 * height).fill(1);
  initialized.fill(0, width * 4 * 7 + 20, width * 4 * 7 + 24);
  const result = transitionBoth(width, height, 0, false, [0, 128, 0], initialized);
  assert.match(result.error, /unwritten/);
});

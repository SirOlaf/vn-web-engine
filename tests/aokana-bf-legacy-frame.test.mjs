import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateAokanaBitmap,
  bitmapStorage,
} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {decodeAokanaLegacyBfFrame} from '../dist/engines/buriko/games/aokana/native/bf-legacy-frame.js';

// These small fixed alphabets have independently specified tree codewords.
// Every listed frequency is one; the bitstream stores each codeword low-bit first.
function packet(expanded, codes) {
  const raw = [expanded.length, 0, 0, 0, 0, expanded.length, ...expanded];
  const header = [
    raw.length,
    ...Array.from({length: 256}, (_, symbol) => Number(codes.has(symbol))),
  ];
  const bits = raw.flatMap((symbol) => [...codes.get(symbol)].map(Number));
  const packed = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((bit, index) => {
    packed[index >>> 3] |= bit << (index & 7);
  });
  return Uint8Array.from([...header, ...packed]);
}

function movie(depth) {
  const key = packet(
    new Uint8Array(16).fill(1),
    new Map([
      [0, '01'],
      [1, '00'],
      [16, '1'],
    ]),
  );
  // One changed block, eight row mask bytes. First pixel uses residuals;
  // second copies the old first pixel, third clears, fourth copies old second.
  const deltaData = [
    1,
    1,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    ...new Array(depth / 8).fill(1),
    255,
    0,
    128,
    0,
    255,
  ];
  const delta = packet(
    deltaData,
    new Map([
      [0, '11'],
      [1, '10'],
      [deltaData.length, '001'],
      [128, '000'],
      [255, '01'],
    ]),
  );
  const bytes = new Uint8Array(0x48 + key.length + delta.length),
    view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('BF_Movie_______\0'));
  view.setUint32(0x14, 2, true);
  view.setUint32(0x18, 2, true);
  view.setUint32(0x1c, depth, true);
  view.setUint32(0x20, depth === 24 ? 1 : 2, true);
  view.setUint32(0x28, 2, true);
  view.setUint32(0x40, 0x48, true);
  view.setUint32(0x44, 0x48 + key.length, true);
  bytes.set(key, 0x48);
  bytes.set(delta, 0x48 + key.length);
  return bytes;
}

function pixels(destination) {
  return Array.from(bitmapStorage(destination, 0, 16, true).bytes);
}

function expected(values, depth) {
  return values.flatMap((value) => [value, value, value, depth === 24 ? 0 : value]);
}

test('legacy BF key and delta frames retain the real bitmap and snapshot signed motion sources', () => {
  for (const depth of [24, 32]) {
    const encoded = movie(depth),
      destination = allocateAokanaBitmap(2, 2, depth === 24 ? 1 : 2);
    const backing = destination.storage;
    assert.equal(decodeAokanaLegacyBfFrame(encoded, 0, destination), true);
    assert.deepEqual(pixels(destination), expected([1, 2, 2, 3], depth));
    assert.equal(decodeAokanaLegacyBfFrame(encoded, 1, destination), true);
    assert.deepEqual(pixels(destination), expected([2, 1, 0, 2], depth));
    assert.equal(destination.storage, backing);
  }
});

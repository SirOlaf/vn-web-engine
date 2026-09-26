import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeCompressedBgLegacy} from '../dist/formats/buriko/compressed-bg.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {
  bitmapRead32,
  bitmapWrite32,
} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {AokanaRawSurfaceExport} from '../dist/engines/buriko/games/aokana/native/raw-surface-export.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaSystemTicks} from '../dist/engines/buriko/games/aokana/native/system-ticks.js';
import {AokanaLegacyBgEncoder} from '../dist/engines/buriko/games/aokana/native/compressed-bg-legacy-encode.js';

test('legacy BG encoder emits independently specified entropy for exported RGB and imports its decoded pixels', () => {
  const surfaces = new AokanaSurfaces(
      new AokanaNativeFonts(new AokanaNativeText()),
      new AokanaBitmapCompositor(),
      new AokanaDistributedAllocator(2),
    ),
    packed = new Uint8Array(16 + 192),
    header = new DataView(packed.buffer),
    count = new Uint8Array(4),
    output = new Uint8Array(816),
    ticks = new AokanaSystemTicks({now: () => 1234});
  assert.equal(surfaces.allocate(0, 64, 1, 1), 1);
  const source = surfaces.snapshot(0),
    expected = [];
  for (let x = 0; x < 64; x++) {
    const value = (x + 1) | ((2 * (x + 1)) << 8) | ((3 * (x + 1)) << 16);
    expected.push(value);
    bitmapWrite32(source, source.offset + x * 4, value);
  }
  header.setUint16(0, 64, true);
  header.setUint16(2, 1, true);
  header.setUint16(4, 24, true);
  header.setUint16(8, 1, true);
  assert.equal(
    new AokanaRawSurfaceExport(surfaces).export(
      {bytes: packed, offset: 16},
      {bytes: count, offset: 0},
      192,
      0,
    ),
    0,
  );
  assert.equal(new DataView(count.buffer).getUint32(0, true), 192);
  assert.equal(
    new AokanaLegacyBgEncoder(ticks).encode(
      {bytes: output, offset: 0},
      {bytes: count, offset: 0},
      {bytes: packed, offset: 0},
    ),
    0,
  );
  const data = new DataView(output.buffer),
    length = new DataView(count.buffer).getUint32(0, true);
  assert.equal(length, 353);
  assert.deepEqual(output.subarray(16, 32), packed.subarray(0, 16));
  assert.equal(data.getUint32(32, true), 194);
  assert.equal(data.getUint32(36, true), 1234);
  assert.equal(data.getUint32(40, true), 256);
  assert.deepEqual(Array.from(output.subarray(44, 48)), [194, 64, 1, 0]);
  assert.deepEqual(Array.from(output.subarray(304, length)), [
    0x3d,
    ...Array.from({length: 15}, () => [0xb6, 0xdb, 0x6d]).flat(),
    0xb6,
    0xdb,
    0x60,
  ]);
  // Independent BigInt recurrence decrypts the frequency bytes for literal histogram assertions.
  let seed = 1234n;
  const table = Array.from(output.subarray(48, 304), (value) => {
      const product = (seed * 0x015a4e35n) & 0xffffffffn;
      seed = (product + 1n) & 0xffffffffn;
      return (value - Number((product >> 16n) & 255n)) & 255;
    }),
    frequencies = new Array(256).fill(0);
  frequencies[1] = 65;
  frequencies[2] = 64;
  frequencies[3] = 64;
  frequencies[0xc0] = 1;
  assert.deepEqual(table, frequencies);
  const decoded = decodeCompressedBgLegacy(output.subarray(0, length));
  assert.equal(decoded.bitDepth, 32);
  const destinationBytes = new Uint8Array(16 + decoded.pixels.length),
    destinationInitialized = new Uint8Array(destinationBytes.length),
    decodedInPlace = decodeCompressedBgLegacy(output.subarray(0, length), {
      bytes: destinationBytes,
      initialized: destinationInitialized,
    });
  assert.deepEqual(decodedInPlace.pixels, decoded.pixels);
  assert.deepEqual(destinationBytes.subarray(16), decoded.pixels);
  assert.ok(
    destinationInitialized.subarray(0, 16 + decoded.pixels.length).every((value) => value === 1),
  );
  assert.equal(
    surfaces.importRaw(1, decoded.width, decoded.height, 2, {bytes: decoded.pixels, offset: 0}),
    1,
  );
  const imported = surfaces.snapshot(1);
  assert.deepEqual(
    expected.map((_, x) => bitmapRead32(imported, imported.offset + x * 4)),
    expected,
  );
});

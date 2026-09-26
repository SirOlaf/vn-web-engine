import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeAokanaSdc, decodeAokanaSdc} from '../dist/engines/buriko/games/aokana/native/sdc.js';
import {decodeSdc} from '../dist/formats/buriko/compressed-resource.js';

test('native SDC emits exact overlapping distance-two tokens and stored-byte checksums', () => {
  const plain = new TextEncoder().encode('AB'.repeat(20)),
    expected = new Uint8Array(41),
    view = new DataView(expected.buffer);
  expected.set(new TextEncoder().encode('SDC FORMAT 1.00\0'));
  view.setUint32(20, 9, true);
  view.setUint32(24, 40, true);
  view.setUint16(28, 1063, true);
  view.setUint16(30, 203, true);
  // Plain tokens: literalAB, match17/distance2, match17/distance2, match4/distance2.
  // Seed0 obfuscates 01 41 42 F8 00 F8 00 90 00 into this exact stored stream.
  expected.set([1, 155, 196, 222, 66, 128, 205, 75, 15], 32);
  assert.deepEqual(encodeAokanaSdc(plain, 0), expected);
  assert.deepEqual(decodeAokanaSdc(expected), plain);
  assert.deepEqual(decodeSdc(expected), plain);
});

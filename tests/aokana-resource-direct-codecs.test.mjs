import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeCompressedBgV1, packedImage} from '../dist/formats/buriko/compressed-bg.js';
import {decodeAokanaResource} from '../dist/engines/buriko/games/aokana/native/resource-decode.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {modernCbg, legacyCbg} from './aokana-resource-direct-fixtures.mjs';

test('direct resource codecs retain real caller pixels and share successful legacy/sliced output semantics', async () => {
  const processing = new AokanaDistributedProcessing(new AokanaDistributedAllocator(1), 1);
  const bytes = new Uint8Array(272),
    initialized = new Uint8Array(272).fill(1);
  for (let i = 16; i < 272; i += 4) bytes.set([17, 33, 49, 71], i);
  const result = await decodeAokanaResource(modernCbg(8, 8, 32, true), processing, 0, 0, {
    bytes,
    initialized,
  });
  assert.equal(result.status, 0);
  assert.equal(result.bytes.buffer, bytes.buffer);
  assert.equal(result.initialized.buffer, initialized.buffer);
  assert.equal(new DataView(bytes.buffer).getUint16(0, true), 8);
  for (let i = 16; i < 272; i += 4)
    assert.deepEqual(Array.from(bytes.subarray(i, i + 4)), [17, 33, 49, 170]);
  assert.equal(
    initialized.every((value) => value === 1),
    true,
  );
  const legacy = legacyCbg(),
    expected = packedImage(decodeCompressedBgV1(legacy));
  const legacyOutput = new Uint8Array(24).fill(0xa5),
    legacyMask = new Uint8Array(24).fill(1);
  assert.equal(
    (
      await decodeAokanaResource(legacy, processing, 0, 0, {
        bytes: legacyOutput,
        initialized: legacyMask,
      })
    ).status,
    0,
  );
  assert.deepEqual(legacyOutput, expected);
  assert.deepEqual(Array.from(legacyOutput.subarray(16)), [1, 1, 1, 0, 2, 2, 2, 0]);
  const slice = new Uint8Array(4).fill(0x99);
  assert.equal((await decodeAokanaResource(legacy, processing, 20, 4, {bytes: slice})).status, 0);
  assert.deepEqual(slice, Uint8Array.of(2, 2, 2, 0));
  const cropped = new Uint8Array(24).fill(0x55);
  assert.equal(
    (await decodeAokanaResource(modernCbg(2, 1, 24), processing, 0, 0, {bytes: cropped})).status,
    0,
  );
  assert.deepEqual(Array.from(cropped.subarray(16)), [128, 128, 128, 128, 128, 128, 0x55, 0x55]);
  processing.dispose();
});

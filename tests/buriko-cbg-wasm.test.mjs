import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeCompressedBgLegacy} from '../dist/formats/buriko/compressed-bg.js';
import {decodeBurikoCompressedBgLegacyAsync} from '../dist/engines/buriko/native/compressed-bg-wasm.js';
import {
  getRuntimePerformanceSnapshot,
  startRuntimePerformanceRecording,
  stopRuntimePerformanceRecording,
} from '../dist/platform/runtime-performance.js';
import {encode, residuals, xorshift} from './buriko-cbg-fixtures.mjs';

function destination(length, shift) {
  if (!shift)
    return {bytes: new Uint8Array(length).fill(0xcd), initialized: new Uint8Array(length)};
  // Initialization flags lead the pixel bytes, so each row's publication rewrites decoded
  // pixels that the next row reads as its upper neighbours.
  const shared = new Uint8Array(length + shift).fill(0xcd);
  return {bytes: shared.subarray(shift, shift + length), initialized: shared.subarray(0, length)};
}

async function outcome(run) {
  try {
    const image = await run();
    return {...image, header: [...image.header], pixels: Buffer.from(image.pixels)};
  } catch (error) {
    return {error: `${error.constructor.name}: ${error.message}`};
  }
}

async function wasmApplied(run) {
  startRuntimePerformanceRecording();
  try {
    await run();
  } finally {
    stopRuntimePerformanceRecording();
  }
  const metric = getRuntimePerformanceSnapshot().aggregates.find(
    (aggregate) => aggregate.name === 'buriko.decode.cbg.wasm-applied',
  );
  return metric?.total ?? 0;
}

test('Wasm legacy CompressedBG stages match the reference output, publication and errors', async () => {
  const random = xorshift(0x13579bdf),
    images = [];
  for (const [width, height, depth] of [
    [17, 5, 8],
    [301, 229, 8],
    [23, 7, 24],
    [333, 211, 24],
    [19, 3, 32],
    [400, 330, 32],
  ]) {
    const bytes = encode({
      width,
      height,
      depth,
      residuals: residuals(random, width * height * (depth >> 3)),
      seed: random(),
    });
    images.push({bytes, extent: 16 + width * height * (depth === 24 ? 4 : depth >> 3), width});
  }
  // The largest stream spans several staged windows.
  assert.ok(images.at(-1).bytes.length > 2 * 128 * 1024);

  for (const {bytes, extent, width} of images) {
    const reference = await outcome(() => decodeCompressedBgLegacy(bytes));
    assert.equal(reference.error, undefined);
    let fast;
    assert.equal(
      await wasmApplied(
        async () => (fast = await outcome(() => decodeBurikoCompressedBgLegacyAsync(bytes))),
      ),
      1,
    );
    assert.deepEqual(fast, reference);
    for (const shift of [0, 16 + width * 2]) {
      const expectedTarget = destination(extent, shift),
        target = destination(extent, shift);
      const expected = await outcome(() => decodeCompressedBgLegacy(bytes, expectedTarget));
      let resumed = 0;
      const actual = await outcome(() =>
        decodeBurikoCompressedBgLegacyAsync(bytes, target, () => resumed++),
      );
      assert.deepEqual(actual, expected);
      assert.deepEqual(target.bytes, expectedTarget.bytes);
      assert.deepEqual(target.initialized, expectedTarget.initialized);
      assert.ok(resumed >= 1);
    }
  }

  // Malformed streams fail in Wasm and rerun the reference stages for the exact error and
  // destination state; bit flips may also decode or fail identically.
  const {bytes, extent} = images[5],
    data = new DataView(bytes.buffer),
    tableEnd = 48 + data.getUint32(40, true),
    withIntermediate = (delta) => {
      const copy = bytes.slice();
      new DataView(copy.buffer).setUint32(32, data.getUint32(32, true) + delta, true);
      return copy;
    };
  // A one-symbol tree has no second child: its final code bit is invalid.
  const singleLeaf = encode({
    width: 4,
    height: 4,
    depth: 8,
    intermediate: new Uint8Array(24),
    seed: 5,
  });
  singleLeaf[singleLeaf.length - 1] |= 1;
  const malformed = [
    bytes.subarray(0, bytes.length - 5),
    withIntermediate(1),
    withIntermediate(-1),
    withIntermediate(-100000),
    singleLeaf,
  ];
  for (let i = 0; i < 24; i++) {
    const copy = bytes.slice(),
      position = tableEnd + (random() % (bytes.length - tableEnd));
    copy[position] ^= 1 << (random() % 8);
    malformed.push(copy);
  }
  let failures = 0;
  for (const input of malformed) {
    const expectedTarget = destination(extent, 0),
      target = destination(extent, 0),
      expected = await outcome(() => decodeCompressedBgLegacy(input, expectedTarget)),
      actual = await outcome(() => decodeBurikoCompressedBgLegacyAsync(input, target));
    assert.deepEqual(actual, expected);
    assert.deepEqual(target.bytes, expectedTarget.bytes);
    assert.deepEqual(target.initialized, expectedTarget.initialized);
    if (expected.error) failures++;
  }
  assert.ok(failures >= 5);
  assert.equal(
    await wasmApplied(() => outcome(() => decodeBurikoCompressedBgLegacyAsync(malformed[0]))),
    0,
  );
});

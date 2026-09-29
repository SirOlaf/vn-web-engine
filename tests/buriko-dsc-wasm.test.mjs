import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeDsc} from '../dist/formats/buriko/dsc.js';
import {decodeBurikoDsc} from '../dist/engines/buriko/native/dsc-wasm.js';
import {
  getRuntimePerformanceSnapshot,
  startRuntimePerformanceRecording,
  stopRuntimePerformanceRecording,
} from '../dist/platform/runtime-performance.js';
import {encode, huffmanLengths, sample, xorshift} from './buriko-dsc-fixtures.mjs';

function outcome(decode, bytes) {
  try {
    return {bytes: decode(bytes)};
  } catch (error) {
    return {error: error.message};
  }
}

function wasmApplied(run) {
  startRuntimePerformanceRecording();
  try {
    run();
  } finally {
    stopRuntimePerformanceRecording();
  }
  const metric = getRuntimePerformanceSnapshot().aggregates.find(
    (aggregate) => aggregate.name === 'buriko.decode.dsc.wasm-applied',
  );
  return metric?.total ?? 0;
}

test('Wasm DSC decoding matches the reference and malformed streams keep reference errors', () => {
  const random = xorshift(0x2468ace1);
  const lengths = huffmanLengths(random);
  assert.ok(Math.max(...lengths) > 12 && Math.min(...lengths.filter(Boolean)) < 12);
  const cases = [
    encode(sample(random, 60), lengths, 0x12345678),
    encode(sample(random, 200_000), lengths, 0xfedcba98),
    encode(sample(random, 5_000), new Uint8Array(512).fill(9), 0),
  ];
  for (const {bytes, expected} of cases) {
    assert.deepEqual(decodeDsc(bytes), expected);
    let decoded;
    assert.equal(
      wasmApplied(() => (decoded = decodeBurikoDsc(bytes))),
      1,
    );
    assert.deepEqual(decoded, expected);
  }

  const {bytes} = cases[1];
  const header = (offset, value) => {
    const copy = bytes.slice();
    new DataView(copy.buffer).setUint32(offset, value, true);
    return copy;
  };
  const invalidTree = bytes.slice();
  invalidTree.fill(0, 32, 32 + 512);
  const malformed = [
    bytes.subarray(0, bytes.length - 3),
    header(20, cases[1].expected.length + 1),
    header(20, cases[1].expected.length - 1),
    header(24, new DataView(bytes.buffer).getUint32(24, true) + 1),
    header(16, 1),
    invalidTree,
    bytes.subarray(0, 0x21f),
  ];
  // Bit flips in the stream decode, fail, or diverge identically under both paths.
  for (let i = 0; i < 40; i++) {
    const copy = bytes.slice(),
      position = 0x220 + (random() % (bytes.length - 0x220));
    copy[position] ^= 1 << (random() % 8);
    malformed.push(copy);
  }
  let failures = 0;
  for (const input of malformed) {
    const reference = outcome(decodeDsc, input),
      fast = outcome(decodeBurikoDsc, input);
    assert.deepEqual(fast, reference);
    if (reference.error) failures++;
  }
  assert.ok(failures >= 7);
  assert.equal(
    wasmApplied(() => assert.throws(() => decodeBurikoDsc(malformed[0]))),
    0,
  );
  assert.throws(() => decodeBurikoDsc(bytes, cases[1].expected.length - 1), {
    message: 'DSC decoded size exceeds resource limit',
  });
});

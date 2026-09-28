import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeCompressedBgLegacy, frequencyTree} from '../dist/formats/buriko/compressed-bg.js';
import {decodeBurikoCompressedBgLegacyAsync} from '../dist/engines/buriko/native/compressed-bg-wasm.js';
import {
  getRuntimePerformanceSnapshot,
  startRuntimePerformanceRecording,
  stopRuntimePerformanceRecording,
} from '../dist/platform/runtime-performance.js';

function xorshift(seed) {
  return () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
}

function varint(value, output) {
  for (;;) {
    const low = value % 128;
    value = Math.floor(value / 128);
    output.push(value ? low | 128 : low);
    if (!value) return output;
  }
}

/** Alternating literal and zero runs, starting with a (possibly empty) literal run. */
function runs(residuals) {
  const output = [];
  let position = 0;
  while (position < residuals.length) {
    let end = position;
    while (end < residuals.length) {
      let zeros = 0;
      while (end + zeros < residuals.length && residuals[end + zeros] === 0) zeros++;
      if (zeros >= 3 || end + zeros === residuals.length) break;
      end += zeros + 1;
    }
    varint(end - position, output);
    for (let i = position; i < end; i++) output.push(residuals[i]);
    position = end;
    if (position === residuals.length) break;
    let zeros = 0;
    while (position + zeros < residuals.length && residuals[position + zeros] === 0) zeros++;
    varint(zeros, output);
    position += zeros;
  }
  return Uint8Array.from(output);
}

/** Legacy CompressedBG with an independently assembled container around the reference tree. */
function encode({
  width,
  height,
  depth,
  residuals,
  seed,
  version = 1,
  intermediate = runs(residuals),
}) {
  const weights = new Array(256).fill(0);
  for (const symbol of intermediate) weights[symbol]++;
  const {root, children} = frequencyTree(weights),
    codes = new Array(256);
  const walk = (node, code) => {
    if (node < 256) codes[node] = code;
    else children[node].forEach((child, bit) => walk(child, code + bit));
  };
  walk(root, '');
  const bits = Array.from(intermediate, (symbol) => codes[symbol]).join(''),
    stream = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) if (bits[i] === '1') stream[i >> 3] |= 128 >> (i & 7);
  const table = [];
  for (const weight of weights) varint(weight, table);
  const bytes = new Uint8Array(48 + table.length + stream.length),
    data = new DataView(bytes.buffer);
  bytes.set(Array.from('CompressedBG___\0', (c) => c.charCodeAt(0)));
  data.setUint16(16, width, true);
  data.setUint16(18, height, true);
  data.setUint16(20, depth, true);
  for (let i = 22; i < 32; i++) bytes[i] = (i * 37) & 255;
  data.setUint32(32, intermediate.length, true);
  data.setUint32(36, seed, true);
  data.setUint32(40, table.length, true);
  let sum = 0,
    xor = 0,
    state = seed;
  table.forEach((value, i) => {
    const product = Number((BigInt(state) * 0x015a4e35n) & 0xffffffffn);
    state = (product + 1) >>> 0;
    bytes[48 + i] = (value + (product >>> 16)) & 255;
    sum = (sum + value) & 255;
    xor ^= value;
  });
  bytes[44] = sum;
  bytes[45] = xor;
  data.setUint16(46, version, true);
  bytes.set(stream, 48 + table.length);
  return bytes;
}

/** Skewed residuals with zero runs; rare symbols have codes longer than sixteen bits. */
function residuals(random, size) {
  const output = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    const r = random();
    if (r % 29 === 0) {
      const zeros = Math.min(size - i, 1 + ((r >>> 8) % 40));
      i += zeros - 1;
    } else output[i] = Math.min(255, Math.floor(-Math.log2(1 - (r >>> 8) / 2 ** 24) * 24));
  }
  return output;
}

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

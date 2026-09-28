import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeDsc} from '../dist/formats/buriko/dsc.js';
import {decodeBurikoDsc} from '../dist/engines/buriko/native/dsc-wasm.js';
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

// Independent integer arithmetic for the native wrapping product recurrence.
function keyStream(seed) {
  let state = BigInt(seed);
  return () => {
    const product = (state * 22695477n) & 0xffffffffn;
    state = (product + 1n) & 0xffffffffn;
    return Number((product >> 16n) & 255n);
  };
}

/** Complete Huffman code lengths; the skew yields codes both shorter and longer than 12 bits. */
function huffmanLengths(random) {
  let nodes = Array.from({length: 512}, (_, symbol) => ({
    weight: 1 + Math.floor(1e7 * 0.975 ** (random() % 512)),
    symbols: [symbol],
  }));
  const lengths = new Uint8Array(512);
  while (nodes.length > 1) {
    nodes.sort((a, b) => a.weight - b.weight);
    const [a, b] = nodes;
    for (const symbol of [...a.symbols, ...b.symbols]) lengths[symbol]++;
    nodes = [
      {weight: a.weight + b.weight, symbols: [...a.symbols, ...b.symbols]},
      ...nodes.slice(2),
    ];
  }
  return lengths;
}

/** Canonical DSC 1.00 encoding of literal and back-reference tokens with independent expected output. */
function encode(tokens, lengths, seed) {
  const order = [...lengths.keys()]
    .filter((symbol) => lengths[symbol])
    .sort((a, b) => lengths[a] - lengths[b] || a - b);
  const codes = new Map();
  let code = 0,
    previous = lengths[order[0]];
  for (const symbol of order) {
    code <<= lengths[symbol] - previous;
    previous = lengths[symbol];
    codes.set(symbol, code++);
  }
  const bits = [];
  const put = (value, count) => {
    for (let bit = count - 1; bit >= 0; bit--) bits.push((value >>> bit) & 1);
  };
  const output = [];
  for (const token of tokens) {
    const symbol = token.literal ?? 256 + token.count - 2;
    put(codes.get(symbol), lengths[symbol]);
    if (token.literal !== undefined) output.push(token.literal);
    else {
      put(token.distance - 2, 12);
      for (let i = 0; i < token.count; i++) output.push(output[output.length - token.distance]);
    }
  }
  const stream = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((bit, i) => (stream[i >>> 3] |= bit << (7 - (i & 7))));
  const bytes = new Uint8Array(0x220 + stream.length);
  bytes.set(new TextEncoder().encode('DSC FORMAT 1.00\0'));
  const header = new DataView(bytes.buffer);
  header.setUint32(16, seed, true);
  header.setUint32(20, output.length, true);
  header.setUint32(24, tokens.length, true);
  const key = keyStream(seed);
  for (let symbol = 0; symbol < 512; symbol++) bytes[32 + symbol] = (lengths[symbol] + key()) & 255;
  bytes.set(stream, 0x220);
  return {bytes, expected: Uint8Array.from(output)};
}

function sample(random, count) {
  // Mostly frequent symbols, with uniform picks to reach long codes; short and
  // overlapping distances exercise repeated-pattern copies.
  const tokens = [];
  let produced = 0;
  for (let i = 0; i < count; i++) {
    const symbol = random() % 4 ? random() % 48 : random() % 512;
    if (symbol < 256 || produced < 2) tokens.push({literal: symbol & 255});
    else {
      const limit = Math.min(produced, 4097),
        distance =
          random() & 1 ? 2 + (random() % Math.min(limit - 1, 19)) : 2 + (random() % (limit - 1));
      tokens.push({count: (symbol & 255) + 2, distance});
    }
    produced += tokens.at(-1).count ?? 1;
  }
  return tokens;
}

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

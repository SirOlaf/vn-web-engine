import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeBurikoBfFrame,
  decodeBurikoBfFrameReference,
} from '../dist/engines/buriko/native/bf-frame.js';
import {burikoBfTree} from '../dist/engines/buriko/native/bf-entropy.js';
import {
  burikoBfEncodedVarint,
  burikoBfEncoderTrees,
  encodeBurikoBfAlphaLz,
  encodeBurikoBfCoefficientRow,
} from '../dist/engines/buriko/native/bf-encode-entropy.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {
  getRuntimePerformanceSnapshot,
  startRuntimePerformanceRecording,
  stopRuntimePerformanceRecording,
} from '../dist/platform/runtime-performance.js';

function xorshift(seed) {
  let state = seed >>> 0 || 1;
  return (limit) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % limit;
  };
}

/** MSB-first Huffman bits for codec 2's decoded bytes. */
function huffmanBits(tree, symbols) {
  const parent = new Map();
  for (let node = tree.leaves; node <= tree.root; node++)
    tree.children[node].forEach((child, bit) => {
      if (child !== 0xffffffff) parent.set(child, [node, bit]);
    });
  const bits = [];
  for (const symbol of symbols) {
    const path = [];
    for (let node = symbol; parent.has(node); node = parent.get(node)[0])
      path.push(parent.get(node)[1]);
    bits.push(...path.reverse());
  }
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((bit, index) => (bytes[index >>> 3] |= bit << (7 - (index & 7))));
  return bytes;
}

/** A random BF frame in the native layout: trees, row table, rows, then the alpha section. */
function encodeFrame(random, width, height, depth, alpha) {
  const alignedWidth = (width + 7) & ~7,
    alignedHeight = (height + 7) & ~7,
    columns = alignedWidth >>> 3,
    rows = alignedHeight >>> 3,
    maskSize = (columns + 7) >>> 3,
    components = depth === 8 ? 1 : 3;
  const records = Array.from({length: rows}, (_, row) => {
    const mask = new Uint8Array(maskSize);
    // Every fourth row is skipped entirely by its zero count.
    let blocks = 0;
    if (row % 4 !== 3)
      for (let column = 0; column < columns; column++)
        if (random(5) !== 0) {
          mask[column >>> 3] |= 1 << (column & 7);
          blocks++;
        }
    const coefficients = new Int16Array(blocks * components * 64);
    for (let block = 0; block < blocks * components; block++) {
      coefficients[block * 64] = random(401) - 200;
      for (let index = 1; index < 64; index++)
        if (random(5) === 0) coefficients[block * 64 + index] = random(121) - 60;
    }
    return {mask, coefficients};
  });
  const coded = records.filter(({coefficients}) => coefficients.length !== 0);
  const {dc, ac, frequencies} = burikoBfEncoderTrees(coded.map(({coefficients}) => coefficients));
  const parts = frequencies.map((frequency) => burikoBfEncodedVarint(frequency));
  const rowBytes = records.map(({mask, coefficients}) => {
    const data =
      coefficients.length === 0 ? null : encodeBurikoBfCoefficientRow(coefficients, dc, ac);
    return Uint8Array.from([
      ...mask,
      ...burikoBfEncodedVarint(coefficients.length),
      ...(data === null ? [] : data.storage.bytes.subarray(0, data.length)),
    ]);
  });
  let alphaSection = new Uint8Array(0);
  if (alpha === 'lz') {
    const pixels = new Uint8Array(width * height * 4);
    for (let at = 3; at < pixels.length; at += 4) pixels[at] = random(3) === 0 ? random(256) : 255;
    const encoded = encodeBurikoBfAlphaLz(pixels, width, width * 4, pixels.length * 2);
    alphaSection = Uint8Array.from([
      1,
      0,
      0,
      0,
      ...encoded.storage.bytes.subarray(0, encoded.length),
    ]);
  } else if (alpha === 'blocks') {
    const decoded = new Array((columns * rows + 7) >>> 3).fill(0);
    for (let block = 0; block < columns * rows; block++) {
      if (random(3) === 0) continue;
      decoded[block >>> 3] |= 1 << (block & 7);
      const x = (block % columns) * 8,
        y = Math.floor(block / columns) * 8;
      for (let yy = y; yy < Math.min(y + 8, height); yy++)
        for (let xx = x; xx < Math.min(x + 8, width); xx++) decoded.push(random(4) * 85);
    }
    const weights = new Array(256).fill(0);
    for (const value of decoded) weights[value]++;
    const size = new Uint8Array(4);
    new DataView(size.buffer).setUint32(0, decoded.length, true);
    alphaSection = Uint8Array.from([
      2,
      0,
      0,
      0,
      ...size,
      ...weights.flatMap((weight) => [...burikoBfEncodedVarint(weight)]),
      ...huffmanBits(burikoBfTree(weights), decoded),
    ]);
  }
  const header = parts.reduce((length, part) => length + part.length, 0),
    table = header + (rows + 1) * 4;
  const total = table + rowBytes.reduce((length, row) => length + row.length, 0);
  const frame = new Uint8Array(total + alphaSection.length + 8),
    view = new DataView(frame.buffer);
  let at = 0;
  for (const part of parts) frame.set(part, (at += part.length) - part.length);
  let offset = table;
  rowBytes.forEach((row, index) => {
    view.setUint32(header + index * 4, offset, true);
    frame.set(row, offset);
    offset += row.length;
  });
  view.setUint32(header + rows * 4, offset, true);
  frame.set(alphaSection, offset);
  return frame;
}

function outcome(decode, frame, width, height, depth, quantization, surface) {
  // A fault leaves its work manager inside the native run barrier.
  const processing = new BurikoDistributedProcessing(new BurikoDistributedAllocator(1), 2);
  try {
    decode(frame, width, height, depth, quantization, processing, surface);
    return {bytes: surface.bytes, initialized: surface.initialized};
  } catch (error) {
    return {error: `${error.constructor.name}: ${error.message}`};
  }
}

function surfaces(random, extent, retained) {
  const bytes = new Uint8Array(extent),
    initialized = new Uint8Array(extent);
  if (retained === 'all') {
    for (let index = 0; index < extent; index++) bytes[index] = random(256);
    initialized.fill(1);
  } else if (retained === 'partial')
    for (let index = 0; index < extent; index++) {
      initialized[index] = random(2);
      bytes[index] = initialized[index] ? random(256) : 0;
    }
  return [0, 1].map(() => ({bytes: bytes.slice(), initialized: initialized.slice()}));
}

function wasmApplied(run) {
  startRuntimePerformanceRecording();
  try {
    run();
  } finally {
    stopRuntimePerformanceRecording();
  }
  const metric = getRuntimePerformanceSnapshot().aggregates.find(
    ({name}) => name === 'buriko.bf.wasm-applied',
  );
  return metric?.total ?? 0;
}

test('Wasm BF frames match the reference for every alpha codec and retained surface', () => {
  const random = xorshift(0x5eed_bf01);
  const quantization = Uint8Array.from({length: 128}, () => 1 + random(24));
  for (const [width, height, depth, alpha] of [
    [37, 21, 24, null],
    [64, 48, 32, 'lz'],
    [45, 30, 32, 'blocks'],
    [16, 16, 8, null],
  ]) {
    const frame = encodeFrame(random, width, height, depth, alpha);
    for (const retained of ['none', 'partial', 'all']) {
      const [kernel, reference] = surfaces(random, width * height * 4, retained);
      const expected = outcome(
        decodeBurikoBfFrameReference,
        frame,
        width,
        height,
        depth,
        quantization,
        reference,
      );
      assert.equal(expected.error, undefined, `${depth}-bit ${alpha} reference`);
      let actual;
      const applied = wasmApplied(
        () =>
          (actual = outcome(
            decodeBurikoBfFrame,
            frame,
            width,
            height,
            depth,
            quantization,
            kernel,
          )),
      );
      assert.equal(applied, 1, `${width}x${height}x${depth} ${alpha} ${retained}`);
      assert.deepEqual(actual, expected, `${width}x${height}x${depth} ${alpha} ${retained}`);
    }
  }
});

test('corrupted BF frames keep the reference outcome', () => {
  const random = xorshift(0x0bad_f00d);
  const quantization = new Uint8Array(128).fill(3);
  let faults = 0;
  for (const [width, height, depth, alpha] of [
    [40, 24, 24, null],
    [40, 24, 32, 'lz'],
    [40, 24, 32, 'blocks'],
  ]) {
    const frame = encodeFrame(random, width, height, depth, alpha);
    for (let trial = 0; trial < 60; trial++) {
      const corrupted = frame.slice();
      // Past the 192 tree weights, so rows, the row table and the alpha section are hit.
      for (let edit = 0; edit < 1 + random(3); edit++)
        corrupted[200 + random(corrupted.length - 200)] = random(256);
      const [kernel, reference] = surfaces(random, width * height * 4, 'none');
      const expected = outcome(
        decodeBurikoBfFrameReference,
        corrupted,
        width,
        height,
        depth,
        quantization,
        reference,
      );
      if (expected.error !== undefined) faults++;
      assert.deepEqual(
        outcome(decodeBurikoBfFrame, corrupted, width, height, depth, quantization, kernel),
        expected,
        `${depth}-bit ${alpha} trial ${trial}`,
      );
    }
  }
  assert.ok(faults > 0, 'corruption reaches reference faults');
});

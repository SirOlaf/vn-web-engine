import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpDiagnostics} from '../dist/engines/buriko/games/aokana/native/diagnostics.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {
  createGroup81Text,
  nativeWordSimilarity,
} from '../dist/engines/buriko/games/aokana/native/group-81-text.js';

function fixture() {
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 32,
    moduleCapacity: 128,
    frameCapacity: 128,
  });
  const memory = new AokanaBpMemory(new Uint8Array(1024));
  const diagnostics = new AokanaBpDiagnostics(() => {}),
    text = new AokanaNativeText();
  const handlers = new Map(createGroup81Text(text).map((slot) => [slot.secondary, slot.execute]));
  const h = {thread, memory, diagnostics};
  return {
    ...h,
    text,
    run(secondary, values, pushes = true) {
      for (const value of values) push32(thread, value);
      assert.equal(handlers.get(secondary)(h), 0);
      return pushes ? pop32(thread) : undefined;
    },
  };
}

function wide(value) {
  const bytes = new Uint8Array((value.length + 1) * 2),
    view = new DataView(bytes.buffer);
  for (let i = 0; i < value.length; i++) view.setUint16(i * 2, value.charCodeAt(i), true);
  return {bytes, offset: 0};
}

test('native WORD similarity has longest-common-subsequence results and null distinction', () => {
  assert.equal(nativeWordSimilarity(null, wide('')), 0xffffffff);
  for (const [a, b, expected] of [
    ['', 'abc', 0],
    ['abc', '', 0],
    ['abcdef', 'ace', 3],
    ['ABCBDAB', 'BDCABA', 4],
    ['abc', 'xyz', 0],
    ['ab', 'ba', 1],
  ]) {
    assert.equal(nativeWordSimilarity(wide(a), wide(b)), expected);
  }
  // UTF-16 code units remain independent native WORDs, including surrogate halves.
  assert.equal(nativeWordSimilarity(wide('\ud800\udc00'), wide('\ud800X\udc00')), 2);
});

test('81 text modes, destination-free lengths and WORD truncation preserve native contracts', () => {
  const h = fixture();
  assert.equal(h.run(0, [1]), 1);
  assert.equal(h.text.codePage, 65001);
  assert.equal(h.run(0, [2]), 0);
  assert.equal(h.text.codePage, 65001);
  h.memory.globalMemory.set(new TextEncoder().encode('A😀\0'), 32);
  assert.equal(h.run(0x27, [32]), 1);
  assert.equal(h.run(0x20, [0, 32, 2]), 3);
  assert.equal(h.run(0x20, [64, 32, 2]), 3);
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => h.memory.readU16(h.thread, 64 + i * 2)),
    [65, 0xd83d, 0xde00, 0],
  );
  assert.equal(h.run(0xb7, [80, 32]), 2);
  assert.deepEqual(
    [0, 1, 2].map((i) => h.memory.readU16(h.thread, 80 + i * 2)),
    [65, 0xf600, 0],
  );
  assert.equal(h.run(0x20, [0, 0, 55]), 0);
  h.memory.globalMemory.set([0x82, 0xa0, 0], 32);
  h.run(0x21, [96, 32], false);
  assert.deepEqual([...h.memory.readCString(h.thread, 96)], [0xe3, 0x81, 0x82]);
  assert.equal(h.run(0xb7, [80, 32]), 1);
  assert.equal(h.memory.readU16(h.thread, 80), 0x82a0);
  h.memory.globalMemory.set([65, 66, 0], 32);
  assert.throws(() => h.run(0x20, [33, 32, 0]), /outside backing/);
});

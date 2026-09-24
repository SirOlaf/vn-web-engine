import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, push32, pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {createGroup91TextTags} from '../dist/engines/buriko/games/aokana/native/group-91-text-tags.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';

test('raw link extraction and in-place tag stripping preserve encoded text and native records', () => {
  const text = new AokanaNativeText(),
    memory = new AokanaBpMemory(new Uint8Array(2048));
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread, memory, diagnostics: {}},
    slots = createGroup91TextTags(text);
  assert.deepEqual(
    slots.map((slot) => slot.secondary),
    [0x9e, 0x9f],
  );
  for (const slot of slots)
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x91][slot.secondary]);
  const call = (secondary, output, source) => {
    const depth = thread.stackIndex;
    push32(thread, output);
    push32(thread, source);
    assert.equal(slots.find((slot) => slot.secondary === secondary).execute(context), 0);
    assert.equal(thread.stackIndex, depth + Number(secondary === 0x9e));
    return secondary === 0x9e ? pop32(thread) : undefined;
  };
  const encoded = text.encodeWide('<l>海</l>と<L>空</L>', 1);
  memory.globalMemory.set(encoded, 32);
  assert.equal(call(0x9e, 0, 32), 2);
  memory.globalMemory.fill(0xaa, 512, 768);
  assert.equal(call(0x9e, 512, 32), 2);
  for (const [index, value] of ['海', '空'].entries()) {
    const expected = text.encodeWide(value, 1),
      offset = 512 + index * 128;
    assert.deepEqual(memory.globalMemory.slice(offset, offset + expected.length), expected);
    assert.ok(
      memory.globalMemory
        .subarray(offset + expected.length, offset + 128)
        .every((byte) => byte === 0),
    );
  }
  // Ordinary source and destination are the same native backing, so the copied
  // prefixes use memmove while the final tail still uses forward string copy.
  memory.globalMemory.set(text.encodeWide('pre<l>sea</l><b>sky</b>end', 1), 256);
  call(0x9f, 256, 256);
  assert.equal(text.decodeAuto({bytes: memory.globalMemory, offset: 256}), 'preseaskyend');
  memory.globalMemory.set([60, 108, 62, 0x82, 0xa0, 60, 47, 108, 62, 0], 96);
  assert.equal(call(0x9e, 800, 96), 1);
  assert.deepEqual(memory.globalMemory.slice(800, 803), new Uint8Array([0x82, 0xa0, 0]));
  assert.equal(thread.stackIndex, 0);
});

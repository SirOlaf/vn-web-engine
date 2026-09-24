import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaProductIdentity} from '../dist/engines/buriko/games/aokana/native/product-identity.js';
import {createGroup80ProductIdentity} from '../dist/engines/buriko/games/aokana/native/group-80-product-identity.js';
import {AokanaNativeText, textLength} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';

test('80:E8 copies the initialized shared product identity into actual native text storage', () => {
  const identity = new AokanaProductIdentity(),
    [slot] = createGroup80ProductIdentity(identity),
    memory = new AokanaBpMemory(new Uint8Array(128)),
    thread = new AokanaBpThread({id: 1, operandCapacity: 4, moduleCapacity: 0, frameCapacity: 0}),
    text = new AokanaNativeText();
  assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x80][0xe8]);
  push32(thread, 32);
  assert.equal(slot.execute({thread, memory, diagnostics: {}}), 0);
  assert.equal(thread.stackIndex, 0);
  const copied = memory.resolve(thread, 32);
  assert.equal(textLength(copied), 26);
  assert.equal(text.decodeAuto(copied), 'AoNoKanataNoFourRhythmUEDL');
  assert.equal(copied.bytes[copied.offset + 26], 0);
});

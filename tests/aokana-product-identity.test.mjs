import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoProductIdentity} from '../dist/engines/buriko/native/product-identity.js';
import {createGroup80ProductIdentity} from '../dist/engines/buriko/native/group-80-product-identity.js';
import {BurikoNativeText, textLength} from '../dist/engines/buriko/native/text.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';

test('80:E8 copies the initialized shared product identity into actual native text storage', () => {
  const identity = new BurikoProductIdentity(
      new TextEncoder().encode('AoNoKanataNoFourRhythmUEDL\0'),
    ),
    [slot] = createGroup80ProductIdentity(identity),
    memory = new BurikoBpMemory(new Uint8Array(128)),
    thread = new BurikoBpThread({id: 1, operandCapacity: 4, moduleCapacity: 0, frameCapacity: 0}),
    text = new BurikoNativeText();
  assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x80][0xe8]);
  push32(thread, 32);
  assert.equal(slot.execute({thread, memory, diagnostics: {}}), 0);
  assert.equal(thread.stackIndex, 0);
  const copied = memory.resolve(thread, 32);
  assert.equal(textLength(copied), 26);
  assert.equal(text.decodeAuto(copied), 'AoNoKanataNoFourRhythmUEDL');
  assert.equal(copied.bytes[copied.offset + 26], 0);
});

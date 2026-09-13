import assert from 'node:assert/strict';
import test from 'node:test';
import {AokanaBpThread, push32, pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaPooledAllocationDiagnostics} from '../dist/engines/buriko/games/aokana/native/diagnostic-records.js';
import {createGroup80Allocation} from '../dist/engines/buriko/games/aokana/native/group-80-allocation.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';

test('native 80 20/21 share the real memory pool and successful module logging bookkeeping', () => {
  const thread = new AokanaBpThread({
    id: 8,
    operandCapacity: 8,
    moduleCapacity: 64,
    frameCapacity: 64,
  });
  const memory = new AokanaBpMemory(new Uint8Array(64));
  thread.modules.push({base: 0, size: 64, name: new TextEncoder().encode('synthetic')});
  thread.instructionStart = 4;
  const records = new AokanaPooledAllocationDiagnostics();
  records.enabled = 1;
  const errors = {
    threadFatal() {
      assert.fail('the successful bookkeeping path must not raise a fatal error');
    },
  };
  const slots = createGroup80Allocation(records, errors),
    h = {thread, memory};
  push32(thread, 16);
  assert.equal(slots[0].execute(h), 0);
  const address = pop32(thread);
  assert.equal(memory.resolve(thread, address).bytes.length, 16);
  assert.equal(records.records.length, 1);
  assert.equal(records.records[0].address, address);
  assert.match(
    new TextDecoder().decode(records.records[0].text),
    /Size \[ 16 \].*Thread \[ 8 \].*Program \[ synthetic \].*IP \[ \$00000004 \]/,
  );
  push32(thread, address);
  assert.equal(slots[1].execute(h), 0);
  assert.equal(pop32(thread), 1);
  assert.equal(records.records.length, 0);
  const generic = memory.allocatePooled(8);
  assert.equal(records.records.length, 0);
  assert.equal(memory.freePooled(generic), true);
  for (const slot of slots)
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[slot.primary][slot.secondary]);
});

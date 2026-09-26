import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoDisplayDamage} from '../dist/engines/buriko/native/display-damage.js';
import {BurikoDisplayManager} from '../dist/engines/buriko/native/display-manager.js';
import {
  BurikoDisplayObject,
  BurikoDisplayObjectEnvironment,
} from '../dist/engines/buriko/native/display-object.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {
  BurikoIndependentProcedure,
  BurikoIndependentProcedures,
} from '../dist/engines/buriko/native/independent-procedure.js';
import {createGroup80Procedures} from '../dist/engines/buriko/native/group-80-procedures.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';

test('80 A8/A9/AC/AF use the actual shared procedure state, copied FIFO and controller polling phase', async () => {
  const compositor = new BurikoBitmapCompositor(),
    environment = new BurikoDisplayObjectEnvironment(
      compositor,
      new BurikoDisplayDamage(32, {left: 0, top: 0, right: 799, bottom: 599}),
    ),
    manager = new BurikoDisplayManager(
      environment,
      new BurikoSurfaces(null, compositor, new BurikoDistributedAllocator(1)),
      new BurikoNativeDisplayState(800, 600),
    ),
    registry = new BurikoIndependentProcedures(manager),
    procedure = new BurikoIndependentProcedure(
      registry,
      new BurikoDisplayObject(environment, 1, 0, 1),
    );
  registry.register(procedure);
  const slots = createGroup80Procedures(registry);
  assert.equal(slots.length, 4);
  for (const slot of slots)
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x80][slot.secondary]);
  const thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 8,
      moduleCapacity: 64,
      frameCapacity: 0,
    }),
    memory = new BurikoBpMemory(new Uint8Array(1)),
    context = {thread, memory};
  const call = (secondary, args) => {
    args.forEach((value) => push32(thread, value));
    assert.equal(slots.find((slot) => slot.secondary === secondary).execute(context), 0);
    return pop32(thread);
  };
  assert.equal(call(0xa8, [procedure.id, 0x12345678]), 1);
  assert.equal(call(0xa9, [procedure.id, 0x10000000]), 1);
  assert.equal(memory.readU32(thread, 0x10000000), 0x12345678);
  memory.writeU32(thread, 0x10000010, 0);
  memory.writeU32(thread, 0x10000014, 7);
  assert.equal(call(0xac, [procedure.id, 2, 0x10000010]), 1);
  memory.writeU32(thread, 0x10000014, 8);
  await procedure.poll();
  assert.equal(procedure.getEnabled(), 7);
  assert.equal(call(0xaf, [1]), 1);
  assert.equal(registry.pollingPhase, 1);
  assert.equal(call(0xaf, [0]), 1);
  assert.equal(registry.pollingPhase, 0);
  assert.equal(thread.stackIndex, 0);
});

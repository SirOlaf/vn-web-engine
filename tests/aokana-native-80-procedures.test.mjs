import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {AokanaDisplayManager} from '../dist/engines/buriko/games/aokana/native/display-manager.js';
import {
  AokanaDisplayObject,
  AokanaDisplayObjectEnvironment,
} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {
  AokanaIndependentProcedure,
  AokanaIndependentProcedures,
} from '../dist/engines/buriko/games/aokana/native/independent-procedure.js';
import {createGroup80Procedures} from '../dist/engines/buriko/games/aokana/native/group-80-procedures.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';

test('80 A8/A9/AC/AF use the actual shared procedure state, copied FIFO and controller polling phase', async () => {
  const compositor = new AokanaBitmapCompositor(),
    environment = new AokanaDisplayObjectEnvironment(
      compositor,
      new AokanaDisplayDamage(32, {left: 0, top: 0, right: 799, bottom: 599}),
    ),
    manager = new AokanaDisplayManager(
      environment,
      new AokanaSurfaces(null, compositor, new AokanaDistributedAllocator(1)),
      new AokanaNativeDisplayState(800, 600),
    ),
    registry = new AokanaIndependentProcedures(manager),
    procedure = new AokanaIndependentProcedure(
      registry,
      new AokanaDisplayObject(environment, 1, 0, 1),
    );
  registry.register(procedure);
  const slots = createGroup80Procedures(registry);
  assert.equal(slots.length, 4);
  for (const slot of slots)
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x80][slot.secondary]);
  const thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 8,
      moduleCapacity: 64,
      frameCapacity: 0,
    }),
    memory = new AokanaBpMemory(new Uint8Array(1)),
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

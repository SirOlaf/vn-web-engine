import test from 'node:test';
import assert from 'node:assert/strict';
import {deviceServiceFixture} from './aokana-device-service-fixture.mjs';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createGroup81Device} from '../dist/engines/buriko/games/aokana/native/group-81-device.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';

function vm(controller) {
  const thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 256,
      frameCapacity: 0,
    }),
    memory = new AokanaBpMemory(),
    slots = createGroup81Device(controller);
  assert.equal(slots.length, 6);
  for (const slot of slots)
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x81][slot.secondary]);
  return {
    thread,
    memory,
    call: async (secondary, args = []) => {
      args.forEach((value) => push32(thread, value));
      assert.equal(
        await slots.find((slot) => slot.secondary === secondary).execute({thread, memory}),
        0,
      );
    },
  };
}

test('six device wrappers use actual cached adapter, current mode, shader and window reconfiguration owners', async () => {
  const s = deviceServiceFixture(),
    identifier = new Uint8Array(0x450);
  identifier.set(Uint8Array.of(32, 32, 65, 32, 32, 0x83, 0x65, 32, 66, 32, 0), 0x200);
  const version = new DataView(identifier.buffer);
  [101, 202, 303, 404].forEach((value, index) => version.setUint16(0x420 + index * 2, value, true));
  s.adapters.records[0].identifier = identifier;
  assert.equal(await s.controller.initialize(), 1);
  const v = vm(s.controller),
    resolved = [],
    resolve = v.memory.resolve.bind(v.memory);
  v.memory.resolve = (thread, address) => {
    resolved.push(address);
    return resolve(thread, address);
  };
  await v.call(0x0b, [0x10000000, 0x10000040, 0x10000060]);
  assert.deepEqual(resolved, [0x10000060, 0x10000040, 0x10000000]);
  const description = resolve(v.thread, 0x10000000);
  assert.deepEqual([...description.bytes.slice(0, 7)], [65, 32, 0x83, 0x65, 32, 66, 0]);
  assert.deepEqual(
    [0, 4, 8, 12].map((offset) => v.memory.readU32(v.thread, 0x10000040 + offset)),
    [404, 303, 202, 101],
  );
  s.mode.width = 32;
  await v.call(0x0e, [0x10000080]);
  assert.deepEqual(
    [v.memory.readU32(v.thread, 0x10000080), v.memory.readU32(v.thread, 0x10000084)],
    [16, 8],
  );
  assert.equal(s.display.desktopWidth, 32);
  await v.call(0x6d);
  assert.equal(pop32(v.thread), 0x300);
  await v.call(0x6f, [4]);
  assert.equal(pop32(v.thread), 1);
  assert.equal(s.device.filterMode, 4);
  await v.call(0x66, [7]);
  assert.equal(s.display.windowStyleOption, 7);
  assert.equal(s.parent['data-aokana-window-style'], '90ce0000');
  await v.call(0x64, [6, 3]);
  assert.deepEqual(
    [s.display.requestedWidth, s.display.requestedHeight, s.display.useSizePreset],
    [6, 3, 0],
  );
  assert.deepEqual([s.canvas.width, s.canvas.height], [6, 3]);
  assert.equal(s.manager.lockDisplay(), 1);
  s.manager.unlockDisplay();
  assert.equal(v.thread.stackIndex, 0);
});

test('client-size preset selection and fullscreen deferred size retain the same live display state', async () => {
  const s = deviceServiceFixture();
  await s.controller.initialize();
  const v = vm(s.controller);
  await v.call(0x64, [0, 7]);
  assert.deepEqual(
    [s.display.requestedWidth, s.display.requestedHeight, s.display.useSizePreset],
    [4, 2, 1],
  );
  assert.deepEqual([s.canvas.width, s.canvas.height], [4, 2]);
  await s.controller.reconfigure(2, 1, 1, null, 0);
  await v.call(0x64, [10, 5]);
  assert.deepEqual(
    [s.display.requestedWidth, s.display.requestedHeight, s.display.useSizePreset],
    [10, 5, 0],
  );
  assert.deepEqual([s.canvas.width, s.canvas.height], [16, 8]);
  await v.call(0x66, [0]);
  assert.equal(s.display.windowStyleOption, 0);
  assert.equal(s.parent['data-aokana-window-style'], '90000000');
  assert.equal(v.thread.stackIndex, 0);
});

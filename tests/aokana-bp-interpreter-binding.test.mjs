import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpThread} from '../dist/engines/buriko/bp/state.js';
import {BurikoBpScheduler} from '../dist/engines/buriko/bp/scheduler.js';
import {BurikoBpDiagnostics} from '../dist/engines/buriko/native/diagnostics.js';
import {BurikoNativeBank} from '../dist/engines/buriko/native/registry.js';
import {
  BURIKO_NATIVE_SLOT_ADDRESSES,
  BURIKO_PRIMARY_SLOT_ADDRESSES,
} from '../dist/engines/buriko/native/inventory.js';
import {BurikoBpModuleExtensions} from '../dist/engines/buriko/bp/module-extensions.js';
import {BurikoBpInterpreter} from '../dist/engines/buriko/bp/interpreter.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {attachModule} from '../dist/engines/buriko/bp/modules.js';
import {controlOpcodes} from '../dist/engines/buriko/bp/opcodes/control.js';

const thread = (id) =>
  new BurikoBpThread({
    id,
    operandCapacity: 16,
    moduleCapacity: 256,
    frameCapacity: 256,
    heapEnabled: false,
  });
function module(payload) {
  const bytes = new Uint8Array(16 + payload.length),
    view = new DataView(bytes.buffer);
  view.setUint32(0, 16, true);
  view.setUint32(4, payload.length, true);
  bytes.set(payload, 16);
  return bytes;
}

test('scheduler binds an interpreter after a test-only complete bank is constructed', async () => {
  const scheduler = new BurikoBpScheduler(thread(0)),
    state = thread(1);
  attachModule(state, 'program fixture', module([0x17]));
  scheduler.append(state);
  await assert.rejects(scheduler.run(), /instruction executor is not bound/);
  assert.equal(state.pc, 0);

  // The unselected fillers only satisfy the bank constructor in this wiring fixture.
  const definitions = Object.entries(BURIKO_NATIVE_SLOT_ADDRESSES).flatMap(([primary, slots]) =>
    Object.entries(slots).map(([secondary, nativeAddress]) => ({
      primary: Number(primary),
      secondary: Number(secondary),
      nativeAddress,
      name: 'Unselected test-only native slot',
      execute: () => assert.fail('Unselected native slot executed'),
    })),
  );
  const primary = Object.fromEntries(
    Object.keys(BURIKO_PRIMARY_SLOT_ADDRESSES)
      .map(Number)
      .filter((opcode) => !BURIKO_NATIVE_SLOT_ADDRESSES[opcode] && opcode !== 0xff)
      .map((opcode) => [opcode, () => assert.fail('Unselected primary slot executed')]),
  );
  const diagnostics = new BurikoBpDiagnostics(() => assert.fail('Unexpected diagnostic')),
    memory = new BurikoBpMemory(new Uint8Array(64)),
    interpreter = new BurikoBpInterpreter(
      {...primary, 0x17: controlOpcodes[0x17]},
      new BurikoNativeBank(definitions),
      new BurikoBpModuleExtensions({readModule: () => null}),
      (current) => ({thread: current, memory, diagnostics}),
    );
  scheduler.bindInstructionExecutor((current) => interpreter.step(current));
  assert.throws(
    () => scheduler.bindInstructionExecutor((current) => interpreter.step(current)),
    /already bound/,
  );
  assert.equal(await scheduler.run(), 0);
  assert.equal(state.pc, 1);
  assert.equal(state.instructionStart, 0);
});

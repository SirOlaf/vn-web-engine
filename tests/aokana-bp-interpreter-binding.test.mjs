import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpThread} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBpScheduler} from '../dist/engines/buriko/games/aokana/bp/scheduler.js';
import {AokanaBpDiagnostics} from '../dist/engines/buriko/games/aokana/native/diagnostics.js';
import {AokanaNativeBank} from '../dist/engines/buriko/games/aokana/native/registry.js';
import {
  AOKANA_NATIVE_SLOT_ADDRESSES,
  AOKANA_PRIMARY_SLOT_ADDRESSES,
} from '../dist/engines/buriko/games/aokana/native/inventory.js';
import {AokanaBpModuleExtensions} from '../dist/engines/buriko/games/aokana/bp/module-extensions.js';
import {AokanaBpInterpreter} from '../dist/engines/buriko/games/aokana/bp/interpreter.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {attachModule} from '../dist/engines/buriko/games/aokana/bp/modules.js';
import {controlOpcodes} from '../dist/engines/buriko/games/aokana/bp/opcodes/control.js';

const thread = (id) =>
  new AokanaBpThread({
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
  const scheduler = new AokanaBpScheduler(thread(0)),
    state = thread(1);
  attachModule(state, 'program fixture', module([0x17]));
  scheduler.append(state);
  await assert.rejects(scheduler.run(), /instruction executor is not bound/);
  assert.equal(state.pc, 0);

  // The unselected fillers only satisfy the bank constructor in this wiring fixture.
  const definitions = Object.entries(AOKANA_NATIVE_SLOT_ADDRESSES).flatMap(([primary, slots]) =>
    Object.entries(slots).map(([secondary, nativeAddress]) => ({
      primary: Number(primary),
      secondary: Number(secondary),
      nativeAddress,
      name: 'Unselected test-only native slot',
      execute: () => assert.fail('Unselected native slot executed'),
    })),
  );
  const primary = Object.fromEntries(
    Object.keys(AOKANA_PRIMARY_SLOT_ADDRESSES)
      .map(Number)
      .filter((opcode) => !AOKANA_NATIVE_SLOT_ADDRESSES[opcode] && opcode !== 0xff)
      .map((opcode) => [opcode, () => assert.fail('Unselected primary slot executed')]),
  );
  const diagnostics = new AokanaBpDiagnostics(() => assert.fail('Unexpected diagnostic')),
    memory = new AokanaBpMemory(new Uint8Array(64)),
    interpreter = new AokanaBpInterpreter(
      {...primary, 0x17: controlOpcodes[0x17]},
      new AokanaNativeBank(definitions),
      new AokanaBpModuleExtensions({readModule: () => null}),
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

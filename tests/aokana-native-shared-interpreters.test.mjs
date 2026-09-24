import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpInterpreter} from '../dist/engines/buriko/games/aokana/bp/interpreter.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpModuleExtensions} from '../dist/engines/buriko/games/aokana/bp/module-extensions.js';
import {controlOpcodes} from '../dist/engines/buriko/games/aokana/bp/opcodes/control.js';
import {AokanaBpThread, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaBpDiagnostics} from '../dist/engines/buriko/games/aokana/native/diagnostics.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaEngineErrors} from '../dist/engines/buriko/games/aokana/native/engine-errors.js';
import {AokanaNativeLocks} from '../dist/engines/buriko/games/aokana/native/exclusion-locks.js';
import {AokanaVmControlState} from '../dist/engines/buriko/games/aokana/native/group-80-threads.js';
import {createGroup91RasterSettings} from '../dist/engines/buriko/games/aokana/native/group-91-raster-settings.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {createGroup81SharedInterpreters} from '../dist/engines/buriko/games/aokana/native/group-81-shared-interpreters.js';
import {
  AOKANA_NATIVE_SLOT_ADDRESSES,
  AOKANA_PRIMARY_SLOT_ADDRESSES,
} from '../dist/engines/buriko/games/aokana/native/inventory.js';
import {AokanaNativeBank} from '../dist/engines/buriko/games/aokana/native/registry.js';
import {AokanaSharedInterpreters} from '../dist/engines/buriko/games/aokana/native/shared-interpreters.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';

const nativeDefinitions = () =>
  Object.entries(AOKANA_NATIVE_SLOT_ADDRESSES).flatMap(([primary, slots]) =>
    Object.entries(slots).map(([secondary, nativeAddress]) => ({
      primary: Number(primary),
      secondary: Number(secondary),
      nativeAddress,
      name: 'Unselected complete native test entry',
      execute: () => {
        throw new Error('Unselected native test entry executed');
      },
    })),
  );

const directHandlers = () =>
  Object.fromEntries(
    Object.keys(AOKANA_PRIMARY_SLOT_ADDRESSES)
      .map(Number)
      .filter((opcode) => !AOKANA_NATIVE_SLOT_ADDRESSES[opcode] && opcode !== 0xff)
      .map((opcode) => [
        opcode,
        () => {
          throw new Error(`Unselected direct test entry ${opcode}`);
        },
      ]),
  );

test('81 48 runs one short result-four child per indexed global worker and restores shared owners', async () => {
  const allocator = new AokanaDistributedAllocator(3),
    processing = new AokanaDistributedProcessing(allocator, 3),
    locks = new AokanaNativeLocks(allocator),
    compositor = new AokanaBitmapCompositor(),
    control = new AokanaVmControlState(),
    diagnostics = new AokanaBpDiagnostics(() => assert.fail('Unexpected write-watch notice')),
    memory = new AokanaBpMemory(new Uint8Array()),
    text = new AokanaNativeText(),
    errors = new AokanaEngineErrors(
      {text},
      {show: () => assert.fail('Unexpected shared-interpreter error dialog')},
      Uint8Array.of(0),
      Uint8Array.of(0),
    ),
    parent = new AokanaBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 64,
      frameCapacity: 64,
    });
  parent.moduleMemory[0] = 0x17;
  parent.moduleSize = 1;
  control.nextThreadId = 10;
  push32(parent, 1);
  const rasterControl = createGroup91RasterSettings(
    compositor,
    new AokanaNativeFonts(text),
    control,
  ).find((slot) => slot.secondary === 0x0b);
  assert.equal(rasterControl.execute({thread: parent, memory, diagnostics}), 0);
  assert.equal(parent.stackIndex, 0);
  compositor.processing = processing;
  const entryActor = allocator.currentActor,
    seen = [];
  const interpreter = new AokanaBpInterpreter(
    {...directHandlers(), 0x17: controlOpcodes[0x17]},
    new AokanaNativeBank(nativeDefinitions()),
    new AokanaBpModuleExtensions({readModule: () => null}),
    (thread) => {
      seen.push({
        id: thread.id,
        index: thread.interpreterNumber,
        mode: thread.mode,
        operandCapacity: thread.operandStack.length,
        moduleMemory: thread.moduleMemory,
        frameMemory: thread.frameMemory,
        heap: thread.heap,
        actor: allocator.currentActor,
        phase: processing.workerState(thread.interpreterNumber).phase,
        compositorProcessing: compositor.processing,
      });
      return {thread, memory, diagnostics};
    },
  );
  const shared = new AokanaSharedInterpreters(
      control,
      processing,
      compositor,
      locks,
      interpreter,
      errors,
    ),
    [definition] = createGroup81SharedInterpreters(shared),
    context = {thread: parent, memory, diagnostics};

  assert.equal(definition.primary, 0x81);
  assert.equal(definition.secondary, 0x48);
  assert.equal(definition.nativeAddress, 0x1400eb470);
  for (const value of [4, 8, 8, 0]) push32(parent, value);
  assert.equal(await definition.execute(context), 0);

  assert.equal(parent.stackIndex, 0);
  assert.equal(control.nextThreadId, 13);
  assert.deepEqual(
    seen.map(({id, index, mode, operandCapacity, phase, compositorProcessing}) => ({
      id,
      index,
      mode,
      operandCapacity,
      phase,
      compositorProcessing,
    })),
    [
      {
        id: 10,
        index: 0,
        mode: 1,
        operandCapacity: 4,
        phase: 'callback',
        compositorProcessing: null,
      },
      {
        id: 11,
        index: 1,
        mode: 1,
        operandCapacity: 4,
        phase: 'callback',
        compositorProcessing: null,
      },
      {
        id: 12,
        index: 2,
        mode: 1,
        operandCapacity: 4,
        phase: 'callback',
        compositorProcessing: null,
      },
    ],
  );
  assert.equal(seen[0].actor, entryActor);
  assert.equal(new Set(seen.map(({actor}) => actor)).size, 3);
  for (const entry of seen) {
    assert.equal(entry.moduleMemory, parent.moduleMemory);
    assert.equal(entry.frameMemory, parent.frameMemory);
    assert.equal(entry.heap, parent.heap);
  }
  assert.equal(parent.retentionCount, 0);
  assert.deepEqual(parent.moduleReservations, []);
  assert.deepEqual(parent.frameReservations, []);
  assert.deepEqual(locks.script.snapshot(), []);
  assert.equal(allocator.currentActor, entryActor);
  assert.equal(compositor.processing, processing);
  for (let worker = 0; worker < processing.capacity; worker++)
    assert.equal(processing.workerState(worker).phase, 'idle');

  let clearedCallbackRuns = 0;
  processing.setCallback(() => {
    clearedCallbackRuns++;
    return 0;
  }, null);
  processing.run(0);
  processing.setCallback(null, null);
  assert.equal(clearedCallbackRuns, 1);
});

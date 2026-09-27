import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpInterpreter} from '../dist/engines/buriko/bp/interpreter.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpModuleExtensions} from '../dist/engines/buriko/bp/module-extensions.js';
import {controlOpcodes} from '../dist/engines/buriko/bp/opcodes/control.js';
import {BurikoBpThread, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoBpDiagnostics} from '../dist/engines/buriko/native/diagnostics.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoEngineErrors} from '../dist/engines/buriko/native/engine-errors.js';
import {BurikoNativeLocks} from '../dist/engines/buriko/native/exclusion-locks.js';
import {BurikoVmControlState} from '../dist/engines/buriko/native/group-80-threads.js';
import {createGroup91RasterSettings} from '../dist/engines/buriko/native/group-91-raster-settings.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {createGroup81SharedInterpreters} from '../dist/engines/buriko/native/group-81-shared-interpreters.js';
import {
  BURIKO_NATIVE_SLOT_ADDRESSES,
  BURIKO_PRIMARY_SLOT_ADDRESSES,
} from '../dist/engines/buriko/native/inventory.js';
import {BurikoNativeBank} from '../dist/engines/buriko/native/registry.js';
import {BurikoSharedInterpreters} from '../dist/engines/buriko/native/shared-interpreters.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {
  getRuntimePerformanceSnapshot,
  startRuntimePerformanceRecording,
  stopRuntimePerformanceRecording,
} from '../dist/platform/runtime-performance.js';

const nativeDefinitions = () =>
  Object.entries(BURIKO_NATIVE_SLOT_ADDRESSES).flatMap(([primary, slots]) =>
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
    Object.keys(BURIKO_PRIMARY_SLOT_ADDRESSES)
      .map(Number)
      .filter((opcode) => !BURIKO_NATIVE_SLOT_ADDRESSES[opcode] && opcode !== 0xff)
      .map((opcode) => [
        opcode,
        () => {
          throw new Error(`Unselected direct test entry ${opcode}`);
        },
      ]),
  );

test('81 48 runs one short result-four child per indexed global worker and restores shared owners', async () => {
  const allocator = new BurikoDistributedAllocator(3),
    processing = new BurikoDistributedProcessing(allocator, 3),
    locks = new BurikoNativeLocks(allocator),
    compositor = new BurikoBitmapCompositor(),
    control = new BurikoVmControlState(),
    diagnostics = new BurikoBpDiagnostics(() => assert.fail('Unexpected write-watch notice')),
    memory = new BurikoBpMemory(new Uint8Array()),
    text = new BurikoNativeText(),
    errors = new BurikoEngineErrors(
      {text},
      {show: () => assert.fail('Unexpected shared-interpreter error dialog')},
      Uint8Array.of(0),
      Uint8Array.of(0),
    ),
    parent = new BurikoBpThread({
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
    new BurikoNativeFonts(text),
    control,
  ).find((slot) => slot.secondary === 0x0b);
  assert.equal(rasterControl.execute({thread: parent, memory, diagnostics}), 0);
  assert.equal(parent.stackIndex, 0);
  compositor.processing = processing;
  const entryActor = allocator.currentActor,
    seen = [];
  const shared = new BurikoSharedInterpreters(control, processing, compositor, locks, null, errors),
    [definition] = createGroup81SharedInterpreters(shared);
  const interpreter = new BurikoBpInterpreter(
    {...directHandlers(), 0x17: controlOpcodes[0x17]},
    new BurikoNativeBank(
      nativeDefinitions().map((slot) =>
        slot.primary === 0x81 && slot.secondary === 0x48 ? definition : slot,
      ),
    ),
    new BurikoBpModuleExtensions({readModule: () => null}),
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
  shared.bindInterpreter(interpreter);
  const context = {thread: parent, memory, diagnostics};

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

function sharedLoopFixture(capacity, execute) {
  const allocator = new BurikoDistributedAllocator(capacity),
    processing = new BurikoDistributedProcessing(allocator, capacity),
    locks = new BurikoNativeLocks(allocator),
    compositor = new BurikoBitmapCompositor(),
    control = new BurikoVmControlState(),
    diagnostics = new BurikoBpDiagnostics(() => assert.fail('Unexpected write-watch notice')),
    memory = new BurikoBpMemory(new Uint8Array()),
    errors = new BurikoEngineErrors(
      {text: new BurikoNativeText()},
      {show: () => assert.fail('Unexpected shared-interpreter error dialog')},
      Uint8Array.of(0),
      Uint8Array.of(0),
    ),
    parent = new BurikoBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 64,
      frameCapacity: 64,
    });
  parent.moduleMemory[0] = 0x17;
  parent.moduleSize = 1;
  control.nextThreadId = 10;
  control.distributedBitmapProcessingEnabled = 1;
  compositor.processing = processing;
  const children = new Set(),
    interpreter = new BurikoBpInterpreter(
      {...directHandlers(), 0x17: execute},
      new BurikoNativeBank(nativeDefinitions()),
      new BurikoBpModuleExtensions({readModule: () => null}),
      (thread) => {
        children.add(thread);
        return {thread, memory, diagnostics};
      },
    ),
    shared = new BurikoSharedInterpreters(
      control,
      processing,
      compositor,
      locks,
      interpreter,
      errors,
    ),
    actor = {};
  return {
    allocator,
    processing,
    locks,
    compositor,
    parent,
    children,
    actor,
    run: () => shared.run(parent, diagnostics, 4, 8, 8, 0, actor),
  };
}

test('shared interpreter yields a cumulative host budget without changing microtask or lock ownership', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const counts = [0, 0],
    microtasks = [0, 0],
    workers = [],
    fixture = sharedLoopFixture(2, ({thread, actor}) => {
      const worker = thread.interpreterNumber;
      assert.equal(fixture.allocator.currentActor, actor);
      assert.equal(microtasks[worker], counts[worker], 'numeric results retain their await');
      if (counts[worker] === 0) assert.equal(fixture.locks.script.enter(lock), 0);
      counts[worker]++;
      workers.push(worker);
      queueMicrotask(() => microtasks[worker]++);
      now++;
      thread.pc = 0;
      if (counts[worker] === (worker === 0 ? 3 : 7)) {
        assert.equal(fixture.locks.script.leave(lock), 0);
        return 4;
      }
      return worker === 1 && counts[worker] === 3 ? Promise.resolve(0) : 0;
    }),
    lock = fixture.locks.script.create(),
    ambient = fixture.allocator.currentActor;
  let atHost;
  const pulse = setTimeout(() => {
    atHost = {
      counts: [...counts],
      actor: fixture.allocator.currentActor,
      owner: fixture.locks.script.snapshot()[0].owner,
      retained: fixture.parent.retentionCount,
    };
  }, 0);
  startRuntimePerformanceRecording();
  try {
    assert.equal(await fixture.run(), 0);
  } finally {
    clearTimeout(pulse);
    stopRuntimePerformanceRecording();
  }
  assert.deepEqual(atHost.counts, [3, 1], 'worker zero time counts toward worker one host yield');
  assert.equal(atHost.actor, ambient, 'host work never inherits a suspended worker actor');
  assert.notEqual(atHost.owner, ambient);
  assert.equal(atHost.retained, 2, 'child storage remains borrowed across the host yield');
  assert.deepEqual(counts, [3, 7]);
  assert.deepEqual(microtasks, counts);
  assert.deepEqual(workers, [0, 0, 0, 1, 1, 1, 1, 1, 1, 1]);
  assert.equal(fixture.parent.retentionCount, 0);
  assert.ok([...fixture.children].every((child) => child.disposed));
  assert.equal(fixture.allocator.currentActor, ambient);
  assert.equal(fixture.compositor.processing, fixture.processing);
  for (let worker = 0; worker < 2; worker++)
    assert.equal(fixture.processing.workerState(worker).phase, 'idle');
  assert.equal(fixture.locks.script.snapshot()[0].acquired, 0);
  assert.equal(fixture.locks.script.remove(lock), 0);
  fixture.processing.dispose();
  const {aggregates, events} = getRuntimePerformanceSnapshot();
  assert.equal(aggregates.find((entry) => entry.name === 'buriko.vm.shared-worker').count, 2);
  const slices = aggregates.find((entry) => entry.name === 'buriko.vm.shared-slice');
  assert.equal(slices.count, 5);
  assert.equal(slices.total, 10);
  assert.equal(
    events.find((entry) => entry.name === 'buriko.vm.shared-worker').detail.instructions,
    7,
  );
});

test('shared interpreter error after a host yield releases actor locks and child reservations', async (t) => {
  let now = 0,
    count = 0;
  t.mock.method(performance, 'now', () => now);
  const failure = new Error('Synthetic shared opcode failure'),
    fixture = sharedLoopFixture(1, ({thread, actor}) => {
      assert.equal(fixture.allocator.currentActor, actor);
      if (++count === 2) throw failure;
      assert.equal(fixture.locks.script.enter(lock), 0);
      thread.pc = 0;
      now += 5;
      return 0;
    }),
    lock = fixture.locks.script.create(),
    ambient = fixture.allocator.currentActor;
  let atHost = 0;
  const pulse = setTimeout(() => {
    atHost = count;
  }, 0);
  try {
    await assert.rejects(fixture.run(), (error) => error === failure);
  } finally {
    clearTimeout(pulse);
  }
  assert.equal(atHost, 1);
  assert.equal(count, 2);
  assert.equal(fixture.allocator.currentActor, ambient);
  assert.equal(fixture.locks.script.snapshot()[0].owner, null);
  assert.equal(fixture.locks.script.snapshot()[0].acquired, 0);
  assert.equal(fixture.locks.script.remove(lock), 0);
  assert.equal(fixture.parent.retentionCount, 0);
  assert.deepEqual(fixture.parent.moduleReservations, []);
  assert.deepEqual(fixture.parent.frameReservations, []);
  assert.ok([...fixture.children].every((child) => child.disposed));
  assert.equal(fixture.compositor.processing, fixture.processing);
  assert.equal(fixture.processing.workerState(0).phase, 'idle');
  fixture.processing.dispose();
});

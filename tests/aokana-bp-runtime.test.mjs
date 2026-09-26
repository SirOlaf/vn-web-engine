import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BurikoBpThread,
  BurikoBpSharedThread,
  push32,
  pop32,
  readFrame32,
} from '../dist/engines/buriko/bp/state.js';
import {
  BurikoBpScheduler,
  BurikoBpScheduledThread,
  BURIKO_BP_BURST_INSTRUCTIONS,
} from '../dist/engines/buriko/bp/scheduler.js';
import {BurikoBpDiagnostics} from '../dist/engines/buriko/native/diagnostics.js';
import {BurikoNativeBank, missingNativeSlots} from '../dist/engines/buriko/native/registry.js';
import {
  BURIKO_NATIVE_SLOT_ADDRESSES,
  BURIKO_PRIMARY_SLOT_ADDRESSES,
} from '../dist/engines/buriko/native/inventory.js';
import {BurikoBpModuleExtensions} from '../dist/engines/buriko/bp/module-extensions.js';
import {BurikoBpInterpreter} from '../dist/engines/buriko/bp/interpreter.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {attachModule} from '../dist/engines/buriko/bp/modules.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoGridEvaluationWorkers} from '../dist/engines/buriko/native/grid-evaluation-workers.js';
import {BurikoLogicalGridManagers} from '../dist/engines/buriko/native/logical-grid.js';

const thread = (id = 1, moduleCapacity = 256, frameCapacity = 256) =>
  new BurikoBpThread({id, operandCapacity: 16, moduleCapacity, frameCapacity, heapEnabled: false});
const root = () => thread(0, 0, 0);

test('native evaluator tasks progress between immediate VM bursts without status-query pumping', async () => {
  const allocator = new BurikoDistributedAllocator(1),
    pool = new BurikoDistributedProcessing(allocator, 1);
  const workers = new BurikoGridEvaluationWorkers(allocator, pool, new BurikoLogicalGridManagers());
  const out = {bytes: new Uint8Array(4), offset: 0},
    view = new DataView(out.bytes.buffer);
  assert.equal(workers.create(out), 0);
  const id = view.getUint32(0, true);
  assert.equal(workers.evaluate(null, null, id, 0, 0), 0);
  let calls = 0;
  const scheduler = new BurikoBpScheduler(root(), () => {
    calls++;
    if (calls === 1) return 2;
    assert.equal(workers.hasPendingWork(), false);
    return 4;
  });
  scheduler.attachGridEvaluationWorkers(workers);
  scheduler.append(thread());
  assert.equal(await scheduler.run(), 0);
  assert.equal(calls, 2);
  assert.equal(workers.takeStatus(out, id), 0);
  assert.notEqual(
    view.getUint32(0, true),
    0,
    'the actual worker reports its invalid record status',
  );
  assert.equal(await workers.destroy(id), 0);
  pool.dispose();
});
const module = (payload) => {
  const bytes = new Uint8Array(16 + payload.length);
  const data = new DataView(bytes.buffer);
  data.setUint32(0, 16, true);
  data.setUint32(4, payload.length, true);
  bytes.set(payload, 16);
  return bytes;
};
const noNotice = () => {
  throw new Error('Unexpected diagnostic');
};
const definitions = () =>
  Object.entries(BURIKO_NATIVE_SLOT_ADDRESSES).flatMap(([primary, slots]) =>
    Object.entries(slots).map(([secondary, nativeAddress]) => ({
      primary: Number(primary),
      secondary: Number(secondary),
      nativeAddress,
      name: 'Synthetic test-only native handler',
      execute: () => {
        throw new Error('Unselected synthetic handler executed');
      },
    })),
  );
const directHandlers = () =>
  Object.fromEntries(
    Object.keys(BURIKO_PRIMARY_SLOT_ADDRESSES)
      .map(Number)
      .filter((op) => !BURIKO_NATIVE_SLOT_ADDRESSES[op] && op !== 0xff)
      .map((op) => [
        op,
        () => {
          throw new Error(`Unselected synthetic primary ${op}`);
        },
      ]),
  );

test('scheduler distinguishes revisit, selected-thread jump, termination, and latched condition', async () => {
  const seen = [],
    removed = [],
    remaining = new Map([
      [1, [2, 3]],
      [2, [4]],
      [3, [5]],
    ]);
  const scheduler = new BurikoBpScheduler(
    root(),
    (state) => {
      seen.push(state.id);
      const next = remaining.get(state.id).shift();
      if (next === 3) scheduler.selectedThreadId = 2;
      return next;
    },
    (node) => removed.push(node.state.id),
  );
  for (const id of [1, 2, 3]) scheduler.append(thread(id));
  assert.equal(await scheduler.run(), 2);
  assert.deepEqual(seen, [1, 1, 2, 3]);
  assert.deepEqual(removed, [2]);
  assert.equal(scheduler.firstThread.next.state.id, 3);
  assert.equal(scheduler.findById(0), null);
});

test('termination retention and exclusive filtering precede the stop gate', async () => {
  const removed = [],
    scheduler = new BurikoBpScheduler(
      root(),
      () => {
        throw new Error('Stopped thread executed');
      },
      (n) => removed.push(n.state.id),
    );
  const a = scheduler.append(thread(1)),
    b = scheduler.append(thread(2));
  a.flags = b.flags = 0x80000000;
  a.state.retentionCount = 1;
  scheduler.stopRequested = true;
  assert.equal(await scheduler.run(), 1);
  assert.deepEqual(removed, [2]);
  scheduler.exclusiveMode = true;
  scheduler.exclusiveThread = null;
  a.state.retentionCount = 0;
  assert.equal(await scheduler.run(), 1);
  assert.deepEqual(removed, [2]);
  scheduler.exclusiveMode = false;
  assert.equal(await scheduler.run(), 1);
  assert.deepEqual(removed, [2, 1]);
});

test('a handler stop continues polling later processes, with a one-time stop message', async () => {
  const events = [],
    scheduler = new BurikoBpScheduler(
      root(),
      (state) => (state.id === 1 ? 6 : assert.fail('Unexpected execution')),
      () => {},
    );
  scheduler.append(thread(1));
  const waiting = scheduler.append(thread(2));
  waiting.installProcess({
    enqueueMessage: (msg) => events.push(msg),
    poll: () => {
      events.push('poll');
      return 0;
    },
    dispose: () => events.push('dispose'),
  });
  assert.equal(await scheduler.run(), 1);
  assert.deepEqual(events, [{code: 0, value1: 0, value2: 0}, 'poll']);
  assert.equal(await scheduler.run(), 1);
  assert.deepEqual(events, [{code: 0, value1: 0, value2: 0}, 'poll', 'poll']);
});

test('poll results -1 and 1 destroy the current process; other nonzero results retain it', () => {
  const node = new BurikoBpScheduledThread(thread()),
    events = [];
  let result = 2;
  node.installProcess({
    enqueueMessage: () => {},
    poll: () => result,
    dispose: () => events.push('dispose'),
  });
  assert.equal(node.pollProcess(false), 2);
  assert.equal(node.flags & 1, 1);
  assert.deepEqual(events, []);
  result = 1;
  assert.equal(node.pollProcess(false), 1);
  assert.equal(node.flags & 1, 0);
  assert.deepEqual(events, ['dispose']);
  node.installProcess(null);
  assert.equal(node.pollProcess(false), -1);
  assert.equal(node.flags & 1, 1);
});

test('a missing selected thread ends traversal; burst limit is exactly 0x400000', async () => {
  let count = 0;
  const scheduler = new BurikoBpScheduler(
    root(),
    () => {
      count++;
      return 0;
    },
    () => {},
  );
  scheduler.append(thread());
  assert.equal(await scheduler.run(), 0);
  assert.equal(count, BURIKO_BP_BURST_INSTRUCTIONS);
  const jump = new BurikoBpScheduler(
    root(),
    () => 3,
    () => {},
  );
  jump.append(thread());
  jump.selectedThreadId = 999;
  assert.equal(await jump.run(), 0);
});

test('thread message FIFO preserves zero and unsigned 32-bit identity', () => {
  const node = new BurikoBpScheduledThread(thread());
  node.enqueueMessage(0);
  node.enqueueMessage(-1);
  assert.equal(node.dequeueMessage(), 0);
  assert.equal(node.dequeueMessage(), 0xffffffff);
  assert.equal(node.dequeueMessage(), undefined);
});

test('write watches use newest first overlap, then the thread-local filter, and wrapping arithmetic', () => {
  const notices = [],
    diagnostics = new BurikoBpDiagnostics((n) => notices.push(n));
  const a = thread(1),
    b = thread(2);
  diagnostics.registerWriteWatch(a, 0x10000004, 4, new Uint8Array([65]));
  diagnostics.registerWriteWatch(b, 0x10000004, 4, new Uint8Array([66]));
  diagnostics.writeWatchEnabled = true;
  diagnostics.checkWrite(a, 0x10000005, 1);
  assert.equal(notices.length, 0);
  diagnostics.checkWrite(b, 0x10000005, 1);
  assert.equal(notices[0].watch.name[0], 66);
  diagnostics.clearWriteWatches();
  diagnostics.registerWriteWatch(a, 4, 8, new Uint8Array());
  diagnostics.checkWrite(b, 11, 1);
  assert.equal(notices.length, 2);
  diagnostics.checkWrite(b, 12, 1);
  assert.equal(notices.length, 2);
  diagnostics.registerWriteWatch(a, 0xfffffffc, 8, new Uint8Array());
  diagnostics.checkWrite(a, 0xfffffffd, 1);
  assert.equal(notices.length, 2);
});

test('native coverage requires all 840 exact distinct slots, rejecting duplicates and misattributions', () => {
  const list = definitions();
  assert.equal(list.length, 840);
  assert.equal(new Set(list.map((x) => x.nativeAddress)).size, 840);
  assert.equal(missingNativeSlots([]).length, 840);
  assert.throws(() => new BurikoNativeBank(list.slice(1)), /incomplete: 1 missing/);
  assert.throws(() => new BurikoNativeBank([...list, list[0]]), /Duplicate/);
  assert.throws(
    () => new BurikoNativeBank([{...list[0], nativeAddress: 1}, ...list.slice(1)]),
    /matching verified slot/,
  );
  assert.doesNotThrow(() => new BurikoNativeBank(list));
});

test('FF mediation appends two modules, saves opcode start+2, and removes both before restoring', () => {
  const state = thread(),
    diagnostics = new BurikoBpDiagnostics(noNotice);
  const context = {thread: state, memory: {}, diagnostics};
  const resource = module([0x17]);
  const extensions = new BurikoBpModuleExtensions({readModule: () => resource});
  attachModule(state, 'caller', module([0xff, 0x05]));
  assert.equal(extensions.register(5, null, new Uint8Array([109])), true);
  state.instructionStart = 0;
  state.pc = 1;
  extensions.execute(context);
  assert.equal(state.pc, 2);
  assert.equal(state.moduleSize, 19);
  assert.equal(state.modules.length, 3);
  assert.equal(readFrame32(state, 0), 2);
  assert.equal(state.frameCursor, 4);
  assert.deepEqual([...state.moduleMemory.subarray(2, 8)], [0x06, 0x10, 0, 0x16, 0xff, 0xf8]);
  state.pc = 7;
  extensions.execute(context);
  assert.equal(state.pc, 2);
  assert.equal(state.moduleSize, 2);
  assert.equal(state.modules.length, 1);
  assert.equal(state.frameCursor, 0);
});

test('FF failed replacement unregisters first; failed second attachment retains mediation', () => {
  let resource = module([0x17]);
  const extensions = new BurikoBpModuleExtensions({readModule: () => resource});
  extensions.register(1, null, new Uint8Array([109]));
  resource = null;
  assert.equal(extensions.register(1, null, new Uint8Array([109])), false);
  const state = thread(1, 18);
  attachModule(state, 'caller', module([0xff, 1]));
  state.pc = 1;
  const context = {thread: state, memory: {}, diagnostics: new BurikoBpDiagnostics(noNotice)};
  assert.throws(() => extensions.execute(context), /Unregistered/);
  resource = module([0x17]);
  extensions.register(1, null, new Uint8Array([109]));
  state.pc = 1;
  assert.throws(() => extensions.execute(context), /does not fit/);
  assert.equal(state.modules.length, 2);
  assert.equal(state.moduleSize, 18);
});

test('interpreter fetch preserves instruction start across secondary fetch and rejects native null slots', () => {
  const state = thread(),
    seen = [],
    native = definitions();
  native.find((d) => d.primary === 0x80 && d.secondary === 0).execute = (context) => {
    seen.push([context.thread.instructionStart, context.thread.pc]);
    return 1;
  };
  const diagnostics = new BurikoBpDiagnostics(noNotice);
  const extensions = new BurikoBpModuleExtensions({readModule: () => null});
  const interpreter = new BurikoBpInterpreter(
    directHandlers(),
    new BurikoNativeBank(native),
    extensions,
    (thread) => ({thread, memory: {}, diagnostics}),
  );
  attachModule(state, 'synthetic', module([0x80, 0, 0x80, 0xff, 0x07]));
  assert.equal(interpreter.step(state), 1);
  assert.deepEqual(seen, [[0, 2]]);
  assert.throws(() => interpreter.step(state), /Invalid Buriko native opcode 80 ff/);
  assert.equal(state.instructionStart, 2);
  assert.equal(state.pc, 4);
  assert.throws(() => interpreter.step(state), /Invalid Buriko primary opcode 0x7/);
});

test('blocking asynchronous host work preserves the burst and forbids concurrent invocations', async () => {
  let release,
    calls = 0;
  const order = [];
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const scheduler = new BurikoBpScheduler(root(), (state) => {
    order.push(state.id);
    calls++;
    return calls === 1 ? pending : 1;
  });
  scheduler.append(thread(1));
  scheduler.append(thread(2));
  const running = scheduler.run();
  assert.deepEqual(order, [1]);
  await assert.rejects(scheduler.run(), /already in progress/);
  release(0);
  assert.equal(await running, 0);
  assert.deepEqual(order, [1, 1, 2]);
});

test('thread destruction frees local storage before process and recursively removes shared borrowers', () => {
  const owner = thread(1),
    child = new BurikoBpSharedThread({id: 2, operandCapacity: 4});
  const scheduler = new BurikoBpScheduler(root(), () => 1),
    events = [];
  const ownerNode = scheduler.append(owner);
  assert.equal(
    child.initialize(owner, 32, 32, 0, (c) => scheduler.append(c)),
    0,
  );
  ownerNode.installProcess({
    enqueueMessage: () => {},
    poll: () => 0,
    dispose: () => events.push([owner.disposed, child.disposed]),
  });
  assert.equal(scheduler.remove(ownerNode), true);
  assert.deepEqual(events, [[true, false]]);
  assert.equal(child.disposed, true);
  assert.equal(owner.retentionCount, 0);
  assert.equal(scheduler.firstThread, null);
});

test('thread diagnostics preserve raw module names and native chronological call records', () => {
  const state = thread();
  const diagnostics = new BurikoBpDiagnostics(noNotice);
  attachModule(state, new Uint8Array([0x81, 0x40]), module([0, 0, 0, 0]));
  attachModule(state, 'callee', module([0x80, 0x45]));
  state.instructionStart = 4;
  state.frameCursor = 0x80;
  state.interpreterNumber = 3;
  state.callSites.push(1, 4);
  diagnostics.errorCode = 0xdeadbeef;
  const bytes = diagnostics.formatThreadMessage(state, new TextEncoder().encode('failure'));
  const text = new TextDecoder().decode(bytes);
  assert.match(text, /Program \[ callee \] , SP \[ \$00000080 \]/);
  assert.match(text, /Instruction \[ \$8045 \]/);
  assert.match(text, /Interpreter Number \[ 3 \]/);
  assert.match(text, /Error Code \[ \$DEADBEEF \]/);
  assert.ok(bytes.includes(0x81));
  assert.ok(text.indexOf('$00000001') < text.indexOf('( callee - $00000000 )'));
  assert.ok(text.endsWith('\n\nfailure'));
});

test('native clock preserves suspension, long-gap exclusion, and 32-bit rollover', async () => {
  const {BurikoNativeClock} = await import('../dist/engines/buriko/native/clock.js');
  let tick = 100;
  const clock = new BurikoNativeClock(() => tick);
  assert.equal(clock.read(), 100n);
  clock.suspensionEnabled = true;
  tick = 110;
  assert.equal(clock.beginSuspension(true), true);
  tick = 210;
  assert.equal(clock.read(), 110n);
  assert.equal(clock.endSuspension(), true);
  tick = 220;
  assert.equal(clock.read(), 120n);
  tick = 1000;
  assert.equal(clock.read(), 120n);
  assert.equal(clock.setGapLimit(49), false);
  assert.equal(clock.setGapLimit(50), true);
  assert.equal(clock.setGapLimit(60000), true);
  assert.equal(clock.setGapLimit(60001), false);
  const rollover = new BurikoNativeClock(() => tick);
  tick = 0xfffffffe;
  assert.equal(rollover.read(), 0n);
  tick = 1;
  assert.equal(rollover.read(), 3n);
});

test('FF asynchronous registration removes old resource before waiting and copies the new bytes', async () => {
  let complete;
  let bytes = module([0x17]);
  const source = {readModule: () => bytes};
  const extensions = new BurikoBpModuleExtensions(source);
  extensions.register(2, null, new Uint8Array([0x81, 0x40]));
  source.readModule = () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  const pending = extensions.register(2, null, new Uint8Array([0x82, 0x41]));
  const state = thread();
  attachModule(state, 'caller', module([0xff, 2]));
  state.pc = 1;
  const context = {thread: state, memory: {}, diagnostics: new BurikoBpDiagnostics(noNotice)};
  assert.throws(() => extensions.execute(context), /Unregistered/);
  complete(bytes);
  assert.equal(await pending, true);
  bytes[16] = 0;
  state.pc = 1;
  extensions.execute(context);
  assert.equal(state.moduleMemory[18], 0x17);
  assert.deepEqual([...state.modules[2].name], [0x82, 0x41]);
});

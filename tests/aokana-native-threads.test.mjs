import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpThread, push32, pop32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpScheduler} from '../dist/engines/buriko/bp/scheduler.js';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {
  BurikoVmControlState,
  createGroup80Threads,
  createGroup80InputWait,
} from '../dist/engines/buriko/native/group-80-threads.js';
import {
  BurikoProcedureState,
  BurikoWaitTiming,
  BurikoWaitWindowMessage,
  BurikoWindowMessages,
} from '../dist/engines/buriko/native/procedure.js';
import {BurikoNativeInput} from '../dist/engines/buriko/native/input.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';

function setup() {
  const control = new BurikoVmControlState();
  const root = new BurikoBpThread({
    id: control.allocateThreadId(),
    operandCapacity: 0,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const scheduler = new BurikoBpScheduler(root, () => 1);
  const thread = new BurikoBpThread({
    id: control.allocateThreadId(),
    operandCapacity: 32,
    moduleCapacity: 64,
    frameCapacity: 64,
  });
  const current = scheduler.append(thread);
  const memory = new BurikoBpMemory(new Uint8Array(64));
  let tick = 0;
  const clock = new BurikoNativeClock(() => tick);
  const procedures = new BurikoProcedureState();
  const messages = new BurikoWindowMessages();
  const dialogs = {
    show() {
      throw new Error('Unexpected dialog');
    },
  };
  const slots = new Map(
    createGroup80Threads(scheduler, clock, control, procedures, messages, dialogs).map((slot) => [
      slot.secondary,
      slot,
    ]),
  );
  const run = (slot, ...args) => {
    for (const arg of args) push32(thread, arg);
    return slots.get(slot).execute({thread, memory});
  };
  return {
    thread,
    current,
    scheduler,
    memory,
    control,
    clock,
    procedures,
    messages,
    run,
    tick(value) {
      tick = value;
    },
  };
}

test('native thread messages preserve FIFO words and write before unlinking the current message', () => {
  const s = setup();
  s.run(0x48, s.thread.id, 0);
  s.run(0x48, s.thread.id, 0xffffffff);
  assert.throws(() => s.run(0x49, 0), /null/);
  assert.equal(s.current.peekMessage(), 0, 'failed destination write retains native message node');
  s.run(0x4b, 4, 4);
  assert.equal(pop32(s.thread), 2);
  assert.equal(s.memory.readU32(s.thread, 4), 0);
  assert.equal(s.memory.readU32(s.thread, 8), 0xffffffff);
  s.run(0x49, 0);
  assert.equal(pop32(s.thread), 0, 'empty receive does not dereference null');
});

test('bulk send validates target before count and commits each source word in order', () => {
  const s = setup();
  assert.throws(() => s.run(0x4a, 999, 0, 0), /does not exist/);
  assert.throws(() => s.run(0x4a, s.thread.id, 0, 0), /not positive/);
  s.memory.writeU32(s.thread, 60, 123);
  assert.throws(() => s.run(0x4a, s.thread.id, 2, 60), /pointer/);
  assert.equal(s.current.dequeueMessage(), 123);
});

test('native procedure message send returns false for absent target or absent procedure', () => {
  const s = setup();
  s.run(0x4c, s.thread.id, 7, 8, 9);
  assert.equal(pop32(s.thread), 0);
  const received = [];
  s.current.installProcess({
    poll: () => 0,
    dispose() {},
    enqueueMessage(message) {
      received.push(message);
    },
  });
  s.run(0x4c, s.thread.id, 7, 8, 9);
  assert.equal(pop32(s.thread), 1);
  assert.deepEqual(received, [{code: 7, value1: 8, value2: 9}]);
  s.run(0x4c, 999, 7, 8, 9);
  assert.equal(pop32(s.thread), 0);
});

test('thread deadlines wrap signed DWORD differences; expired wait returns revisit without replacing procedure', () => {
  const s = setup();
  s.tick(100);
  s.run(0x58, 50);
  s.tick(120);
  assert.equal(s.run(0x5a), 2);
  assert.equal(pop32(s.thread), 1);
  const process = s.current.process;
  assert.equal(process.poll(), 0);
  s.tick(160);
  assert.equal(s.run(0x5a), 2);
  assert.equal(pop32(s.thread), 0);
  assert.equal(s.current.process, process);
  assert.equal(process.poll(), 1);
  s.run(0x59, 100);
  assert.equal(pop32(s.thread), 1);
  assert.equal(s.current.deadline, 250);
});

test('procedure stop consumes through the first stop only, and message3 overrides global disable', () => {
  const s = setup();
  s.procedures.enabled = 0;
  const first = new BurikoWaitTiming(s.thread, s.procedures, s.clock, 100);
  first.enqueueMessage({code: 3, value1: 0, value2: 0});
  assert.equal(first.poll(), 0);
  first.enqueueMessage({code: 0, value1: 0, value2: 0});
  first.enqueueMessage({code: 3, value1: 0, value2: 0});
  assert.equal(first.poll(), 1);
  const second = new BurikoWaitTiming(s.thread, s.procedures, s.clock, 100);
  assert.equal(second.poll(), 1);
  assert.equal(second.id, first.id + 1);
});

test('window messages broadcast and overwrite each matching registration, then consume received state', () => {
  const s = setup();
  const process = new BurikoWaitWindowMessage(
    s.thread,
    s.procedures,
    s.clock,
    s.messages,
    {
      show() {
        throw new Error('Unexpected');
      },
    },
    0x401,
  );
  assert.equal(process.poll(), 0);
  s.messages.dispatch(0x401, 0x123456789n, -1n);
  assert.equal(process.poll(), 1);
  assert.equal(pop32(s.thread), 0xffffffff);
  assert.equal(pop32(s.thread), 0x23456789);
  assert.equal(process.poll(), 0);
  process.enqueueMessage({code: 0, value1: 0, value2: 0});
  assert.equal(process.poll(), 1);
  assert.equal(pop32(s.thread), 0xffffffff);
  assert.equal(pop32(s.thread), 0xffffffff);
  process.dispose();
  assert.equal(s.messages.consume(s.thread, 0x401), null);
});

test('missing window registration awaits the actual dialog before process completion', async () => {
  const s = setup();
  let finish;
  const dialog = {
    show(message) {
      assert.equal(message.buttons, 'ok');
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
  const process = new BurikoWaitWindowMessage(
    s.thread,
    s.procedures,
    s.clock,
    s.messages,
    dialog,
    0x401,
  );
  s.messages.clear();
  s.current.installProcess(process);
  const run = s.scheduler.run();
  assert.equal(s.current.process, process);
  await assert.rejects(s.scheduler.run(), /already in progress/);
  finish(1);
  assert.equal(await run, 0);
  assert.equal(s.current.process, null);
});

test('native control slots write persistent state and return exact scheduler codes', () => {
  const s = setup();
  s.run(0x52, 0xffffffff);
  assert.equal(s.control.loopOption, 0xffffffff);
  s.run(0x53);
  assert.equal(s.control.asynchronousResourceLoads, 1);
  s.run(0x5d, 1);
  assert.equal(s.scheduler.exclusiveThread, s.current);
  assert.equal(s.scheduler.exclusiveMode, true);
  s.run(0x5d, 0);
  assert.equal(s.scheduler.exclusiveThread, null);
  assert.equal(s.scheduler.exclusiveMode, false);
  assert.equal(s.run(0x45), 4);
  assert.equal(s.run(0x5e, 123), 3);
  assert.equal(s.scheduler.selectedThreadId, 123);
  assert.equal(s.run(0x5f), 1);
  assert.equal(s.run(0x6a), 6);
});

test('input-sensitive wait consumes capture setup and distinguishes input from procedure completion', () => {
  const s = setup();
  const input = new BurikoNativeInput(new BurikoNativeDisplayState(1920, 1080), s.clock);
  input.foreground = input.inputActive = true;
  const slot = createGroup80InputWait(s.scheduler, s.clock, s.procedures, input)[0];
  const start = (enabled) => {
    push32(s.thread, 100);
    push32(s.thread, enabled);
    push32(s.thread, 4);
    assert.equal(slot.execute({thread: s.thread, memory: s.memory}), 2);
  };
  start(1);
  assert.equal(s.current.process.poll(), 0);
  input.recordKeyDown(13);
  assert.equal(s.current.process.poll(), 1);
  assert.equal(pop32(s.thread), 1);
  s.current.process.dispose();
  start(0);
  s.current.process.enqueueMessage({code: 1, value1: 0, value2: 0});
  assert.equal(s.current.process.poll(), 1);
  assert.equal(pop32(s.thread), 0);
  s.current.process.dispose();
});

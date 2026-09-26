import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {
  AokanaProcedureState,
  AokanaWaitTiming,
} from '../dist/engines/buriko/games/aokana/native/procedure.js';
import {AokanaNativeNotifications} from '../dist/engines/buriko/games/aokana/native/notification-queue.js';
import {createGroup80Notifications} from '../dist/engines/buriko/games/aokana/native/group-80-notifications.js';
import {createGroup80ProcedureControl} from '../dist/engines/buriko/games/aokana/native/group-80-procedure-control.js';

test('80:50 controls an actual shared wait and A1 publishes into the existing A0 notification FIFO', () => {
  const memory = new AokanaBpMemory(new Uint8Array(0x1000)),
    thread = new AokanaBpThread({id: 1, operandCapacity: 16, moduleCapacity: 0, frameCapacity: 0}),
    context = {memory, thread},
    procedures = new AokanaProcedureState(),
    queue = new AokanaNativeNotifications(),
    [control] = createGroup80ProcedureControl(procedures),
    notifications = createGroup80Notifications(queue);
  let tick = 100;
  const clock = new AokanaNativeClock(() => tick),
    first = new AokanaWaitTiming(thread, procedures, clock, 50);
  assert.equal(first.poll(), 0);
  push32(thread, 0);
  assert.equal(control.execute(context), 1);
  assert.equal(thread.stackIndex, 0);
  assert.equal(first.poll(), 1);
  first.dispose();
  push32(thread, 0xffffffff);
  assert.equal(control.execute(context), 1);
  assert.equal(procedures.enabled, 0xffffffff);
  const second = new AokanaWaitTiming(thread, procedures, clock, 50);
  assert.equal(second.poll(), 0);
  tick = 150;
  assert.equal(second.poll(), 1);
  second.dispose();
  const append = notifications.find((s) => s.secondary === 0xa1),
    take = notifications.find((s) => s.secondary === 0xa0);
  for (const pair of [
    [0x12345678, 0x90abcdef],
    [7, 9],
  ]) {
    for (const value of pair) push32(thread, value);
    assert.equal(append.execute(context), 0);
    assert.equal(thread.stackIndex, 0);
  }
  const view = new DataView(memory.globalMemory.buffer);
  for (const pair of [
    [0x12345678, 0x90abcdef],
    [7, 9],
  ]) {
    push32(thread, 0x100);
    assert.equal(take.execute(context), 0);
    assert.equal(pop32(thread), 1);
    assert.deepEqual(
      [view.getUint32(0x100, true), view.getUint32(0x104, true), view.getUint32(0x108, true)],
      [0, ...pair],
    );
  }
  assert.equal(thread.stackIndex, 0);
});

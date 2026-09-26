import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {BurikoProcedureState, BurikoWaitTiming} from '../dist/engines/buriko/native/procedure.js';
import {BurikoNativeNotifications} from '../dist/engines/buriko/native/notification-queue.js';
import {createGroup80Notifications} from '../dist/engines/buriko/native/group-80-notifications.js';
import {createGroup80ProcedureControl} from '../dist/engines/buriko/native/group-80-procedure-control.js';

test('80:50 controls an actual shared wait and A1 publishes into the existing A0 notification FIFO', () => {
  const memory = new BurikoBpMemory(new Uint8Array(0x1000)),
    thread = new BurikoBpThread({id: 1, operandCapacity: 16, moduleCapacity: 0, frameCapacity: 0}),
    context = {memory, thread},
    procedures = new BurikoProcedureState(),
    queue = new BurikoNativeNotifications(),
    [control] = createGroup80ProcedureControl(procedures),
    notifications = createGroup80Notifications(queue);
  let tick = 100;
  const clock = new BurikoNativeClock(() => tick),
    first = new BurikoWaitTiming(thread, procedures, clock, 50);
  assert.equal(first.poll(), 0);
  push32(thread, 0);
  assert.equal(control.execute(context), 1);
  assert.equal(thread.stackIndex, 0);
  assert.equal(first.poll(), 1);
  first.dispose();
  push32(thread, 0xffffffff);
  assert.equal(control.execute(context), 1);
  assert.equal(procedures.enabled, 0xffffffff);
  const second = new BurikoWaitTiming(thread, procedures, clock, 50);
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

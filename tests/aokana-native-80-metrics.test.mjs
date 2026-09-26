import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {BurikoFrameMetrics} from '../dist/engines/buriko/native/frame-metrics.js';
import {createGroup80Metrics} from '../dist/engines/buriko/native/group-80-metrics.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';

test('80 06/07 expose the actual committed frame metrics with native stack and DWORD output order', () => {
  let ticks = 0n;
  const metrics = new BurikoFrameMetrics(
    {queryCounter: () => ticks, queryFrequency: () => 1000000n},
    new BurikoNativeClock(() => 0),
    {refreshRate: 60, readRasterScanline: () => 0x81000000},
  );
  const slots = createGroup80Metrics(metrics);
  assert.equal(slots.length, 2);
  for (const slot of slots)
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x80][slot.secondary]);
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 8,
    moduleCapacity: 16,
    frameCapacity: 0,
  });
  const memory = new BurikoBpMemory(),
    context = {thread, memory};
  const enable = (value) => {
    push32(thread, value);
    assert.equal(slots[0].execute(context), 0);
  };
  const read = (selector) => {
    push32(thread, 0x10000000);
    push32(thread, selector);
    assert.equal(slots[1].execute(context), 0);
    return memory.readU32(thread, 0x10000000);
  };
  enable(1);
  metrics.begin();
  ticks = 250n;
  metrics.end(0);
  assert.equal(read(0), 0);
  metrics.begin();
  ticks = 1250n;
  metrics.end(1);
  assert.deepEqual([read(0), read(1), read(3), read(42)], [1, 1250, 10000, 0]);
  enable(0);
  assert.equal(read(0), 1);
  enable(2);
  assert.equal(read(0), 0);
  assert.equal(thread.stackIndex, 0);
});

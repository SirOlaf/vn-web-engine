import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {AokanaFrameMetrics} from '../dist/engines/buriko/games/aokana/native/frame-metrics.js';
import {createGroup80Metrics} from '../dist/engines/buriko/games/aokana/native/group-80-metrics.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';

test('80 06/07 expose the actual committed frame metrics with native stack and DWORD output order', () => {
  let ticks = 0n;
  const metrics = new AokanaFrameMetrics(
    {queryCounter: () => ticks, queryFrequency: () => 1000000n},
    new AokanaNativeClock(() => 0),
    {refreshRate: 60, readRasterScanline: () => 0x81000000},
  );
  const slots = createGroup80Metrics(metrics);
  assert.equal(slots.length, 2);
  for (const slot of slots)
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x80][slot.secondary]);
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 8,
    moduleCapacity: 16,
    frameCapacity: 0,
  });
  const memory = new AokanaBpMemory(),
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

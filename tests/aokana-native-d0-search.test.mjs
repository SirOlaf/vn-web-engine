import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AokanaLogicalSpatialManager,
  AokanaLogicalSpatialManagers,
} from '../dist/engines/buriko/games/aokana/native/logical-spatial.js';
import {AokanaLogicalSpatialSearch} from '../dist/engines/buriko/games/aokana/native/logical-spatial-search.js';
import {createGroupD0SpatialSearch} from '../dist/engines/buriko/games/aokana/native/group-d0-spatial-search.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';

function fixture(capacity = 3) {
  const manager = new AokanaLogicalSpatialManager(),
    allocator = new AokanaDistributedAllocator(capacity),
    pool = new AokanaDistributedProcessing(allocator, capacity),
    search = new AokanaLogicalSpatialSearch(manager, pool),
    bytes = new Uint8Array(256).fill(0x55),
    pointer = {bytes, offset: 16};
  manager.createRecord(0, [0, 0, 0, 0, 0, 0, 1, 0, 0], 1, 7);
  manager.createRecord(1, [2, 0, 0, 0, 0, 0, 1, 0, 0], 1, 8);
  return {manager, pool, search, bytes, pointer};
}

test('D072 validates source, target and upper grid bounds before touching the work manager', () => {
  const {search, bytes, pointer, pool} = fixture();
  assert.equal(search.query(null, null, 3, 4, 0, 0, 0, 0, 0, 0), 0xa0000001);
  assert.equal(search.query(null, null, 0, 4, 0, 0, 0, 0, 0, 0), 0xa0000002);
  assert.equal(search.query(pointer, pointer, 0, 1, 0, 0, 0, 0, 0, 0), 0xa0000006);
  assert.equal(search.width, undefined);
  assert.deepEqual(bytes, new Uint8Array(256).fill(0x55));
  assert.equal(pool.workerState(0).phase, 'idle');
});

test('D072 executes native setup and empty-queue lifecycle after RSQRT zero rejects the only seed', () => {
  const {search, bytes, pointer, pool} = fixture();
  assert.equal(search.query(pointer, pointer, 0, 1, 4, 1, 0x103, 7, 0x20, 1), 0xa0000006);
  assert.equal(search.width, 17);
  assert.equal(search.height, 17);
  assert.equal(search.priority, 7);
  assert.equal(search.radius, 1);
  assert.equal(search.sourceIndex, 0);
  assert.equal(search.resolution, 0x20);
  assert.equal(search.mask, 0x103);
  assert.equal(search.checkSegment, 7);
  assert.equal(search.active, false);
  assert.equal(search.goal, -1);
  assert.ok(Number.isNaN(search.seedDistance));
  // Refined reciprocal(1) is below one, but CVTPS2DQ rounds target x to four.
  assert.deepEqual([...search.goals.slice(0, 8)], [16, 8, 0, 0, 15, 11, 0, 0]);
  assert.equal(search.floatDirections, null);
  assert.equal(search.integerDirections, null);
  assert.equal(search.cells, null);
  assert.deepEqual(bytes, new Uint8Array(256).fill(0x55));
  for (let id = 0; id < 3; id++) assert.equal(pool.workerState(id).phase, 'idle');
  assert.equal(search.query(null, null, 0, 1, 4, 0, 0, 0, 99, 0), 0xa0000006);
  assert.equal(search.step, 1);
  assert.equal(search.resolution, 2);
  pool.dispose();
});

test('D072 preserves native single-worker undefined wake ownership instead of inventing a result', () => {
  const {search, pool} = fixture(1);
  assert.equal(search.query(null, null, 0, 1, 4, 1, 0, 0, 0, 0), 0xa0000006);
  assert.throws(
    () => search.query(null, null, 0, 1, 4, 1, 0, 0, 0, 1),
    /uninitialized wake-all flag/,
  );
  assert.equal(pool.distributedFlag, 1);
});

test('D072 wrapper converts its two fixed arguments and consumes eleven native values', () => {
  const managers = new AokanaLogicalSpatialManagers(),
    pool = new AokanaDistributedProcessing(new AokanaDistributedAllocator(2), 2),
    bytes = new Uint8Array(256),
    memory = new AokanaBpMemory(bytes),
    thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 64,
      moduleCapacity: 64,
      frameCapacity: 64,
    }),
    h = {thread, memory},
    definition = createGroupD0SpatialSearch(managers, pool)[0];
  managers.create({bytes, offset: 16});
  const id = new DataView(bytes.buffer).getUint32(16, true);
  managers.use(id, (manager) => {
    manager.createRecord(0, [0, 0, 0, 0, 0, 0, 1, 0, 0], 1, 0);
    return 0;
  });
  bytes.fill(0x55, 64);
  for (const value of [64, 128, id, 0, 0, 2 * 65536, 65536, 0x123, 9, 2, 1]) push32(thread, value);
  assert.equal(definition.execute(h), 0);
  assert.equal(pop32(thread), 0x16);
  assert.equal(thread.stackIndex, 0);
  assert.deepEqual(bytes.slice(64), new Uint8Array(192).fill(0x55));
  pool.dispose();
});

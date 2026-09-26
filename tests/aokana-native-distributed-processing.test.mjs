import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';

test('work construction preserves all worker IDs, initial gates and one-worker callback path', () => {
  const allocator = new BurikoDistributedAllocator(4),
    pool = new BurikoDistributedProcessing(allocator, 4);
  assert.equal(pool.capacity, 4);
  assert.equal(pool.activeCapacity, 4);
  assert.deepEqual(pool.workerState(0), {
    started: true,
    parked: false,
    phase: 'idle',
    activation: null,
    wake: false,
    gates: [null, null, null, null],
  });
  for (let id = 1; id < 4; id++)
    assert.deepEqual(pool.workerState(id), {
      started: true,
      parked: false,
      phase: 'idle',
      activation: true,
      wake: false,
      gates: [null, null, 'main', 'worker'],
    });
  const work = [];
  let count = 7;
  pool.setWorkerCallback((_context, id) => {
    if (count-- <= 0) return 0;
    work.push(id);
    return 1;
  }, null);
  pool.run(1);
  assert.deepEqual(work, [0, 1, 2, 3, 0, 1, 2]);
  for (let id = 1; id < 4; id++)
    assert.deepEqual(pool.workerState(id).gates, [null, null, 'main', 'worker']);
  count = 3;
  work.length = 0;
  pool.run(0);
  assert.deepEqual(work, [0, 0, 0]);
  pool.dispose();
  assert.equal(pool.alive, false);
  assert.equal(pool.workerState(3).phase, 'terminated');
  assert.throws(() => pool.run(0), /destroyed/);
  assert.throws(() => new BurikoDistributedProcessing(allocator, 0), /worker zero/);
});

test('callback setters share context without clearing priority callback and use low DWORD result', () => {
  const allocator = new BurikoDistributedAllocator(2),
    pool = new BurikoDistributedProcessing(allocator, 2),
    seen = [];
  pool.setCallback((context) => {
    seen.push(['plain', context]);
    return 0x100000000;
  }, 'old');
  pool.setWorkerCallback((context, id) => {
    seen.push(['indexed', context, id]);
    return 0;
  }, 'new');
  pool.run(0);
  assert.deepEqual(seen, [['plain', 'new']]);
  pool.setCallback(null, 'final');
  pool.run(1);
  assert.deepEqual(seen.slice(1), [
    ['indexed', 'final', 0],
    ['indexed', 'final', 1],
  ]);
});

test('global work allocation preserves weighted quotas, tie order and rejected over-capacity requests', () => {
  const allocator = new BurikoDistributedAllocator(5),
    first = new BurikoDistributedProcessing(allocator, 4),
    second = new BurikoDistributedProcessing(allocator, 4);
  allocator.update(first, true);
  assert.equal(first.activeCapacity, 4); // Requested five is rejected, not clamped.
  allocator.update(second, true);
  assert.equal(first.activeCapacity, 2);
  assert.equal(second.activeCapacity, 3); // Newest equal-priority pool receives the remainder.
  assert.equal(first.workerState(2).activation, false);
  assert.equal(first.workerState(1).activation, true);
  assert.equal(first.setActiveCapacity(5), 0);
  assert.equal(first.activeCapacity, 2);
  allocator.update(second, false);
  assert.equal(second.activeCapacity, 4);
  assert.equal(first.activeCapacity, 2); // Native rejects the new five-worker request.
  allocator.dispose();
  assert.equal(first.activeCapacity, 4);
  assert.equal(allocator.initialized, false);
  allocator.initialize();
  assert.equal(allocator.initialized, true);
});

test('park resumes the same callback, wake does not clear parked until continuation resumes', () => {
  const allocator = new BurikoDistributedAllocator(3),
    pool = new BurikoDistributedProcessing(allocator, 3),
    seen = [];
  pool.setWorkerCallback(function* (_context, id) {
    seen.push(['start', id]);
    if (id === 0) {
      const result = yield* pool.park(id);
      seen.push(['resumed', result, pool.workerState(id).parked]);
    } else if (id === 1) {
      assert.equal(pool.workerState(0).parked, true);
      pool.wake(1);
      assert.equal(pool.workerState(0).parked, true);
      assert.equal(pool.workerState(0).wake, true);
    }
    return 0;
  }, null);
  pool.run(1);
  assert.deepEqual(seen, [
    ['start', 0],
    ['start', 1],
    ['start', 2],
    ['resumed', 1, false],
  ]);
  assert.equal(pool.workerState(0).wake, false);
});

test('last eligible worker cannot park and wake-all latch prevents subsequent parks in a run', () => {
  const allocator = new BurikoDistributedAllocator(3),
    pool = new BurikoDistributedProcessing(allocator, 3),
    seen = [];
  pool.setWorkerCallback(function* (_context, id) {
    const result = yield* pool.park(id);
    seen.push([id, result]);
    if (id === 2) {
      pool.wake(0);
      assert.equal(yield* pool.park(id), 0);
    }
    return 0;
  }, null);
  pool.run(1);
  assert.deepEqual(seen, [
    [2, 0],
    [0, 1],
    [1, 1],
  ]);
  pool.setWorkerCallback(() => {
    pool.wake(0);
    return 0;
  }, null);
  assert.throws(() => pool.run(0), /unowned critical section/);
});

test('shared locking follows native conditions, recursive ownership and explicit undefined paths', () => {
  const allocator = new BurikoDistributedAllocator(2),
    pool = new BurikoDistributedProcessing(allocator, 2);
  assert.equal(pool.enterShared(), 0);
  pool.leaveShared(0);
  assert.throws(() => pool.leaveShared(1), /unowned critical section/);
  pool.setCallback(() => {
    assert.equal(pool.enterShared(), 1);
    assert.equal(pool.enterShared(), 1);
    pool.leaveShared(1);
    pool.leaveShared(1);
    return 0;
  }, null);
  pool.run(1);
  const single = new BurikoDistributedProcessing(allocator, 1);
  single.setWorkerCallback(function* (_context, id) {
    assert.equal(yield* single.park(id + 1), 0);
    return 0;
  }, null);
  single.run(1);
  single.setCallback(() => {
    single.wake(0);
    return 0;
  }, null);
  assert.throws(() => single.run(1), /uninitialized wake-all flag/);
});

test('nested pools share allocation and restore their caller actor and active events', () => {
  const allocator = new BurikoDistributedAllocator(2),
    outer = new BurikoDistributedProcessing(allocator, 2),
    inner = new BurikoDistributedProcessing(allocator, 2),
    seen = [];
  let nested = false;
  inner.setWorkerCallback((_context, id) => {
    seen.push(['inner', id, outer.activeCapacity]);
    return 0;
  }, null);
  outer.setWorkerCallback((_context, id) => {
    outer.enterShared();
    if (!nested) {
      nested = true;
      inner.run(1);
    }
    outer.leaveShared(1);
    seen.push(['outer', id, outer.activeCapacity]);
    return 0;
  }, null);
  outer.run(1);
  assert.deepEqual(seen, [
    ['inner', 0, 1],
    ['inner', 1, 2],
    ['outer', 0, 2],
    ['outer', 1, 2],
  ]);
});

test('a nested pool can resume after an ancestor worker signals its parked callback', () => {
  const allocator = new BurikoDistributedAllocator(4),
    outer = new BurikoDistributedProcessing(allocator, 2),
    inner = new BurikoDistributedProcessing(allocator, 2);
  let innerParked = false,
    completed = false;
  inner.setWorkerCallback(function* (_context, id) {
    if (id === 0) {
      innerParked = true;
      assert.equal(yield* inner.park(0), 1);
      completed = true;
    }
    return 0;
  }, null);
  outer.setWorkerCallback(function* (_context, id) {
    if (id === 0) inner.run(1);
    else {
      while (!innerParked) yield* outer.cooperate();
      inner.wake(1);
    }
    return 0;
  }, null);
  outer.run(1);
  assert.equal(completed, true);
});

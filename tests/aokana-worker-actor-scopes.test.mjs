import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {createBurikoDisplayLocks} from '../dist/engines/buriko/native/exclusion-locks.js';

test('actual indexed workers retain their operation actor through ordinary recursive lock work', async () => {
  const allocator = new BurikoDistributedAllocator(2),
    ambient = allocator.currentActor,
    operationActor = {},
    processing = new BurikoDistributedProcessing(allocator, 2),
    locks = createBurikoDisplayLocks(allocator),
    scriptLock = locks.script.create(),
    completed = [];
  try {
    await processing.runWorkerCallbackAsync(
      async (_context, worker, actor) => {
        assert.equal(allocator.currentActor, actor);
        await locks.enterEngineAsync(2, actor);
        allocator.withActor(actor, () => {
          assert.equal(locks.script.enter(scriptLock), 0);
          assert.equal(locks.script.enter(scriptLock), 0);
        });
        const owned = locks.script.snapshot().find((entry) => entry.id === scriptLock);
        assert.equal(owned.owner, actor);
        assert.equal(owned.acquired, 2);
        assert.equal(locks.releaseScriptCurrentActor(actor), 2);
        locks.leaveEngine(2, actor);
        completed.push({worker, actor});
        return 0;
      },
      null,
      1,
      operationActor,
    );
    assert.deepEqual(
      completed.map((entry) => entry.worker),
      [0, 1],
    );
    assert.equal(completed[0].actor, operationActor);
    assert.notEqual(completed[1].actor, operationActor);
    assert.equal(allocator.currentActor, ambient);
    const released = locks.script.snapshot().find((entry) => entry.id === scriptLock);
    assert.equal(released.acquired, 0);
    assert.equal(released.admitted, 0);
    assert.equal(released.owner, null);
    assert.equal(locks.script.remove(scriptLock), 0);
  } finally {
    processing.dispose();
    locks.disposeEngine();
  }
});

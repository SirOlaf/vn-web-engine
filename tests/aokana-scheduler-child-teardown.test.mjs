import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AokanaBpThread,
  AokanaBpSharedThread,
} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBpScheduler} from '../dist/engines/buriko/games/aokana/bp/scheduler.js';

test('root child teardown retires the native linked chain from tail to head', () => {
  const root = new AokanaBpThread({
      id: 0,
      operandCapacity: 0,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    owner = new AokanaBpThread({
      id: 1,
      operandCapacity: 8,
      moduleCapacity: 64,
      frameCapacity: 64,
    }),
    shared = new AokanaBpSharedThread({id: 2, operandCapacity: 8}),
    sibling = new AokanaBpThread({
      id: 3,
      operandCapacity: 8,
      moduleCapacity: 64,
      frameCapacity: 64,
    }),
    removed = [],
    scheduler = new AokanaBpScheduler(root, undefined, (node) => removed.push(node.state.id));
  scheduler.append(owner);
  assert.equal(
    shared.initialize(owner, 32, 32, 0, (child) => scheduler.append(child)),
    0,
  );
  scheduler.append(sibling);

  scheduler.removeAllChildren();
  assert.deepEqual(removed, [3, 2, 1]);
  assert.equal(scheduler.firstThread, null);
  assert.equal(scheduler.root.state, root);
  assert.equal(root.disposed, false);
  assert.equal(owner.disposed, true);
  assert.equal(shared.disposed, true);
  assert.equal(sibling.disposed, true);
  assert.equal(owner.retentionCount, 0);
});

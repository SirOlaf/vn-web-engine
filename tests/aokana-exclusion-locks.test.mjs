import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoNativeLocks} from '../dist/engines/buriko/native/exclusion-locks.js';
import {BurikoDisplayRedraw} from '../dist/engines/buriko/native/display-redraw.js';

test('both native registries consume one identity sequence and retain newest-first records', () => {
  const actors = {currentActor: {}},
    locks = new BurikoNativeLocks(actors);
  assert.equal(locks.script.create(), 1);
  locks.initializeEngine();
  assert.deepEqual(
    Array.from({length: 5}, (_, index) => locks.engineId(index)),
    [2, 3, 4, 5, 6],
  );
  assert.equal(locks.script.create(), 7);
  assert.deepEqual(
    locks.script.snapshot().map(({id}) => id),
    [7, 1],
  );
  assert.deepEqual(
    locks.engine.snapshot().map(({id}) => id),
    [6, 5, 4, 3, 2],
  );
  assert.equal(locks.script.remove(7), 0);
  assert.equal(locks.script.create(), 8);
  locks.disposeEngine();
  assert.deepEqual(locks.engine.snapshot(), []);
  assert.deepEqual(
    locks.script.snapshot().map(({id}) => id),
    [8, 1],
  );
});

test('recursive native acquisitions retain separate admission and acquisition counts', () => {
  const actors = {currentActor: {}},
    locks = new BurikoNativeLocks(actors);
  locks.initializeEngine();
  const first = locks.script.create(),
    second = locks.script.create();
  assert.equal(locks.script.enter(first), 0);
  assert.equal(locks.script.enter(first), 0);
  assert.equal(locks.script.tryEnter(first), 0);
  assert.equal(locks.script.enter(second), 0);
  locks.enterEngine(0);
  assert.deepEqual(locks.script.snapshot(), [
    {id: second, admitted: 1, acquired: 1, owner: actors.currentActor},
    {id: first, admitted: 3, acquired: 3, owner: actors.currentActor},
  ]);
  assert.equal(locks.script.leave(first), 0);
  assert.equal(locks.releaseScriptCurrentActor(), 3);
  assert.deepEqual(locks.script.snapshot(), [
    {id: second, admitted: 0, acquired: 0, owner: null},
    {id: first, admitted: 0, acquired: 0, owner: null},
  ]);
  const sprite = locks.engine.snapshot().find(({id}) => id === locks.engineId(0));
  assert.deepEqual(sprite, {id: 1, admitted: 1, acquired: 1, owner: actors.currentActor});
  locks.leaveEngine(0);
});

test('redraw coalescing owns the actual shared engine lock one during each pending write', () => {
  const actors = {currentActor: {}},
    locks = new BurikoNativeLocks(actors),
    redraw = new BurikoDisplayRedraw();
  locks.initializeEngine();
  redraw.bindLocks(locks);
  let pending = 0;
  const observed = [];
  Object.defineProperty(redraw, 'pending', {
    get: () => pending,
    set(value) {
      const record = locks.engine.snapshot().find(({id}) => id === locks.engineId(1));
      observed.push([
        value,
        record.admitted,
        record.acquired,
        record.owner === actors.currentActor,
      ]);
      pending = value;
    },
  });
  redraw.request(0);
  redraw.request(1);
  assert.deepEqual(observed, [[1, 1, 1, true]]);
  assert.equal(redraw.pending, 1);
  assert.equal(redraw.mode, 1);
  assert.deepEqual(
    locks.engine.snapshot().map(({admitted, acquired}) => [admitted, acquired]),
    Array.from({length: 5}, () => [0, 0]),
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AokanaDisplayObject,
  AokanaDisplayObjectEnvironment,
} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaDisplayObjectLists} from '../dist/engines/buriko/games/aokana/native/display-object-lists.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {
  AokanaDisplayRenderJobs,
  aokanaDisplayStripCount,
  aokanaDisplayStrips,
} from '../dist/engines/buriko/games/aokana/native/display-render-jobs.js';
import {AokanaDisplayRedraw} from '../dist/engines/buriko/games/aokana/native/display-redraw.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaBitmapStorage} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
const rect = (left, top, right, bottom) => ({left, top, right, bottom});

test('redraw request replaces the initial mode, then accumulates later requests', () => {
  const redraw = new AokanaDisplayRedraw();
  assert.equal(redraw.pending, 0);
  assert.equal(redraw.mode, 1);
  redraw.request(0);
  assert.equal(redraw.pending, 1);
  assert.equal(redraw.mode, 0);
  redraw.request(4);
  redraw.request(1);
  assert.equal(redraw.mode, 5);
});

test('native strip construction retains signed height and DWORD coordinate wrap', () => {
  assert.equal(aokanaDisplayStripCount(8, rect(1, 2, 4, 6)), 3);
  assert.deepEqual(aokanaDisplayStrips(8, rect(1, 2, 4, 6)), [
    rect(1, 2, 4, 3),
    rect(1, 4, 4, 5),
    rect(1, 6, 4, 6),
  ]);
  assert.deepEqual(aokanaDisplayStrips(0, rect(0, 0, 9, 1)), [rect(0, 0, 9, 0), rect(0, 1, 9, 1)]);
  assert.throws(() => aokanaDisplayStripCount(8, rect(4, 0, 3, 1)), /division by zero/);
  assert.equal(aokanaDisplayStripCount(8, rect(0, 2, 3, 0)), 0);
  assert.deepEqual(aokanaDisplayStrips(4, rect(0, 0x7fffffff, 3, -0x80000000)), [
    rect(0, 0x7fffffff, 3, 0x7fffffff),
    rect(0, -0x80000000, 3, -0x80000000),
  ]);
});

test('concrete pool draws ordinary and expanded objects with inclusive native key intervals', () => {
  const compositor = new AokanaBitmapCompositor(),
    lists = new AokanaDisplayObjectLists();
  const env = new AokanaDisplayObjectEnvironment(
    compositor,
    new AokanaDisplayDamage(16, rect(0, 0, 3, 3)),
  );
  const pool = new AokanaDistributedProcessing(new AokanaDistributedAllocator(2), 2),
    calls = [];
  class Draw extends AokanaDisplayObject {
    constructor(name, key, category = 1) {
      super(env, category, 0, 1);
      this.name = name;
      this.key = key;
      this.configureGeometry(4, 4);
      this.setActivation(1);
    }
    sortKey() {
      return this.key;
    }
    draw(destination, rectangle, key) {
      calls.push({
        name: this.name,
        key,
        rectangle: {...rectangle},
        attached: compositor.processing === pool,
      });
    }
  }
  class Expanded extends Draw {
    hasExpandedSortKeys() {
      return 1;
    }
  }
  const root = new Draw('root', 0, 0),
    a = new Draw('a', 10),
    b = new Draw('b', 20),
    expanded = new Expanded('expanded', 999);
  expanded.replaceExpandedSortKeys(Uint32Array.of(10, 20));
  for (const obj of [root, a, b, expanded]) lists.insert(obj);
  const context = {
    bitmap: {
      storage: new AokanaBitmapStorage(new Uint8Array(64), true),
      offset: 0,
      stride: 16,
      width: 4,
      height: 4,
      format: 2,
      bytesPerPixel: 4,
    },
    bounds: rect(0, 0, 3, 3),
  };
  const jobs = new AokanaDisplayRenderJobs(lists, compositor, pool, context, 15);
  jobs.run([{rectangle: rect(0, 0, 3, 1), key: 123}], 0);
  assert.deepEqual(
    calls.map((c) => [c.name, c.key]),
    [
      ['root', 123],
      ['expanded', 20],
      ['b', 123],
      ['expanded', 20],
    ],
  );
  assert.ok(calls.every((c) => c.attached));
  assert.equal(compositor.processing, null);
  calls.length = 0;
  jobs.minimumKey = 0;
  jobs.run([{rectangle: rect(0, 2, 3, 3), key: 9}], 1);
  assert.deepEqual(
    calls.map((c) => [c.name, c.key]),
    [
      ['root', 9],
      ['expanded', 10],
      ['a', 9],
      ['expanded', 10],
      ['expanded', 20],
      ['b', 9],
      ['expanded', 20],
    ],
  );
  assert.ok(calls.every((c) => !c.attached));
  pool.dispose();
});

test('live list traversal detects destruction of its current native node', () => {
  const lists = new AokanaDisplayObjectLists();
  const env = new AokanaDisplayObjectEnvironment(
    new AokanaBitmapCompositor(),
    new AokanaDisplayDamage(8, rect(0, 0, 1, 1)),
  );
  const obj = new AokanaDisplayObject(env, 0, 0, 1);
  lists.insert(obj);
  const entries = lists.entries(false);
  const node = entries.next().value;
  assert.equal(lists.remove(obj), 1);
  assert.throws(() => node.object, /released/);
  assert.throws(() => entries.next(), /released/);
});

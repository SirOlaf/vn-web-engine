import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BurikoDisplayObject,
  BurikoDisplayObjectEnvironment,
} from '../dist/engines/buriko/native/display-object.js';
import {BurikoDisplayObjectLists} from '../dist/engines/buriko/native/display-object-lists.js';
import {BurikoDisplayDamage} from '../dist/engines/buriko/native/display-damage.js';
import {
  BurikoDisplayRenderJobs,
  burikoDisplayStripCount,
  burikoDisplayStrips,
} from '../dist/engines/buriko/native/display-render-jobs.js';
import {BurikoDisplayRedraw} from '../dist/engines/buriko/native/display-redraw.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoBitmapStorage} from '../dist/engines/buriko/native/bitmap.js';
const rect = (left, top, right, bottom) => ({left, top, right, bottom});

test('redraw request replaces the initial mode, then accumulates later requests', () => {
  const redraw = new BurikoDisplayRedraw();
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
  assert.equal(burikoDisplayStripCount(8, rect(1, 2, 4, 6)), 3);
  assert.deepEqual(burikoDisplayStrips(8, rect(1, 2, 4, 6)), [
    rect(1, 2, 4, 3),
    rect(1, 4, 4, 5),
    rect(1, 6, 4, 6),
  ]);
  assert.deepEqual(burikoDisplayStrips(0, rect(0, 0, 9, 1)), [rect(0, 0, 9, 0), rect(0, 1, 9, 1)]);
  assert.throws(() => burikoDisplayStripCount(8, rect(4, 0, 3, 1)), /division by zero/);
  assert.equal(burikoDisplayStripCount(8, rect(0, 2, 3, 0)), 0);
  assert.deepEqual(burikoDisplayStrips(4, rect(0, 0x7fffffff, 3, -0x80000000)), [
    rect(0, 0x7fffffff, 3, 0x7fffffff),
    rect(0, -0x80000000, 3, -0x80000000),
  ]);
});

test('concrete pool draws ordinary and expanded objects with inclusive native key intervals', () => {
  const compositor = new BurikoBitmapCompositor(),
    lists = new BurikoDisplayObjectLists();
  const env = new BurikoDisplayObjectEnvironment(
    compositor,
    new BurikoDisplayDamage(16, rect(0, 0, 3, 3)),
  );
  const pool = new BurikoDistributedProcessing(new BurikoDistributedAllocator(2), 2),
    calls = [];
  class Draw extends BurikoDisplayObject {
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
      storage: new BurikoBitmapStorage(new Uint8Array(64), true),
      offset: 0,
      stride: 16,
      width: 4,
      height: 4,
      format: 2,
      bytesPerPixel: 4,
    },
    bounds: rect(0, 0, 3, 3),
  };
  const jobs = new BurikoDisplayRenderJobs(lists, compositor, pool, context, 15);
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
  const lists = new BurikoDisplayObjectLists();
  const env = new BurikoDisplayObjectEnvironment(
    new BurikoBitmapCompositor(),
    new BurikoDisplayDamage(8, rect(0, 0, 1, 1)),
  );
  const obj = new BurikoDisplayObject(env, 0, 0, 1);
  lists.insert(obj);
  const entries = lists.entries(false);
  const node = entries.next().value;
  assert.equal(lists.remove(obj), 1);
  assert.throws(() => node.object, /released/);
  assert.throws(() => entries.next(), /released/);
});

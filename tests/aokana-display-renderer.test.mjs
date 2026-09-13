import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBitmapStorage} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {
  AokanaDisplayObject,
  AokanaDisplayObjectEnvironment,
} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaDisplayManager} from '../dist/engines/buriko/games/aokana/native/display-manager.js';
import {AokanaDisplayRenderer} from '../dist/engines/buriko/games/aokana/native/display-renderer.js';
import {AokanaInnerDisplayObjectManager} from '../dist/engines/buriko/games/aokana/native/object-manager.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';

const rect = (left, top, right, bottom) => ({left, top, right, bottom});
const bitmap = (width, height, initial = 0) => ({
  storage: new AokanaBitmapStorage(
    new Uint8Array(new Uint32Array(width * height).fill(initial).buffer),
    true,
  ),
  offset: 0,
  stride: width * 4,
  width,
  height,
  format: 1,
  bytesPerPixel: 4,
});
function setup(pixelBudget = 8, external = false) {
  const compositor = new AokanaBitmapCompositor();
  compositor.defaultFormat = 1;
  const environment = new AokanaDisplayObjectEnvironment(
    compositor,
    new AokanaDisplayDamage(1024, rect(0, 0, 3, 3)),
  );
  const allocator = new AokanaDistributedAllocator(2);
  const surfaces = new AokanaSurfaces(
    new AokanaNativeFonts(new AokanaNativeText()),
    compositor,
    allocator,
  );
  const manager = new AokanaDisplayManager(
    environment,
    surfaces,
    new AokanaNativeDisplayState(1920, 1080),
  );
  const context = {bitmap: bitmap(4, 4), bounds: rect(0, 0, 3, 3)};
  manager.bindDisplayContext(context);
  manager.backdrop.resizeToDisplay();
  const processing = external ? new AokanaDistributedProcessing(allocator, 2) : null;
  const renderer = new AokanaDisplayRenderer(manager, pixelBudget, processing);
  return {compositor, environment, allocator, manager, renderer, context};
}

test('full and partial traversals preserve native strip boundaries, recorded keys and notification order', () => {
  const {manager, renderer, environment} = setup();
  const calls = [];
  class Observed extends AokanaDisplayObject {
    draw(destination, rectangle, key) {
      calls.push(['draw', {...rectangle}, key]);
    }
    notify(...args) {
      calls.push(['notify', ...args, environment.damage.count]);
    }
  }
  const handle = manager.createSimple('sprite', (order) => new Observed(environment, 1, order, 1));
  const object = manager.find('sprite', handle);
  object.configureGeometry(4, 4);
  object.setActivation(1);
  assert.equal(manager.renderPixelBudget, 8);
  assert.deepEqual(renderer.drawDamage(), {count: 0xffffffff, rectangles: []});
  assert.deepEqual(calls, [
    ['draw', rect(0, 0, 3, 1), 0],
    ['draw', rect(0, 2, 3, 3), 0],
    ['notify', 0xf0000000, 0, 0, 0],
  ]);
  calls.length = 0;
  environment.damage.record(0x87654321, rect(1, 1, 2, 2));
  assert.deepEqual(renderer.drawDamage(), {count: 1, rectangles: [rect(1, 1, 2, 2)]});
  assert.deepEqual(calls, [
    ['draw', rect(1, 1, 2, 2), 0x87654321],
    ['notify', 0xf0000000, 0, 0, 0],
  ]);
  assert.deepEqual(renderer.collectOrdinary(), [manager.backdrop, object]);
  assert.equal(manager.redraw.pending, 0);
});

test('conditional invalidation precedes draw choice and damage created by notifications survives', () => {
  const {manager, renderer, environment} = setup();
  const calls = [];
  class Observed extends AokanaDisplayObject {
    invalidate() {
      calls.push('invalidate');
      environment.damage.record(5, rect(0, 0, 0, 0));
    }
    draw(_bitmap, rectangle, key) {
      calls.push(['draw', {...rectangle}, key]);
    }
    notify() {
      calls.push('notify');
      environment.damage.record(7, rect(3, 3, 3, 3));
    }
  }
  const handle = manager.createSimple('sprite', (order) => new Observed(environment, 1, order, 1));
  const object = manager.resolve(handle);
  object.configureGeometry(4, 4);
  object.setActivation(1);
  object.conditionalDamage = 1;
  environment.damage.clear();
  renderer.drawDamage();
  assert.deepEqual(calls, ['invalidate', ['draw', rect(0, 0, 0, 0), 5], 'notify']);
  assert.deepEqual(environment.damage.snapshot(), [{rectangle: rect(3, 3, 3, 3), key: 7}]);
});

test('effector roots retain constructor order and the separate strip and partial-draw predicates', () => {
  const {manager, renderer, environment} = setup();
  environment.damage.clear();
  const seen = [];
  class Effector extends AokanaDisplayObject {
    constructor(name, visible, mode) {
      super(environment, 6, 0, 1);
      this.name = name;
      this.visible = visible;
      this.effectorMode = mode;
    }
    inputActive() {
      seen.push(this.name);
      return this.visible;
    }
  }
  const a = new Effector('a', 1, 4),
    b = new Effector('b', 0, 2);
  manager.effectors.add(a);
  manager.effectors.add(b);
  assert.equal(renderer.canUseStrips(), 1);
  assert.deepEqual(seen, ['b', 'a']);
  assert.equal(renderer.canDrawDamage(), 0);
  b.visible = 1;
  assert.equal(renderer.canUseStrips(), 0);
  manager.effectors.remove(b);
  assert.equal(renderer.canUseStrips(), 1);
  manager.effectors.remove(a);
  assert.equal(renderer.canDrawDamage(), 1);
  manager.setBackdropRenderType(7);
  assert.equal(renderer.canUseStrips(), 0);
  manager.setBackdropRenderType(8);
  assert.equal(renderer.canUseStrips(), 1);
  manager.setMinimumLayer(3);
  assert.equal(manager.minimumKey, 0x30000);
  assert.equal(renderer.canDrawDamage(), 0);
});

test('translated output clears first and passes object-local coordinates into the same shared lists', () => {
  const {manager, renderer, environment} = setup();
  manager.backdrop.setActivation(0);
  const target = bitmap(2, 2, 0x112233),
    calls = [];
  class Observed extends AokanaDisplayObject {
    draw(destination, rectangle) {
      calls.push({
        offset: destination.offset,
        rectangle: {...rectangle},
        first: destination.storage.view.getUint32(0, true),
      });
    }
  }
  const handle = manager.createSimple('sprite', (order) => new Observed(environment, 1, order, 1));
  const object = manager.resolve(handle);
  object.configureGeometry(4, 4);
  object.setActivation(1);
  renderer.drawToBitmap(target, 0);
  assert.deepEqual(calls, [{offset: 0, rectangle: rect(0, 0, 1, 1), first: 0x112233}]);
  renderer.drawTranslated(target, 1, 2, 0);
  assert.deepEqual(calls[1], {offset: 0, rectangle: rect(1, 2, 2, 3), first: 0});
  assert.deepEqual(Array.from(new Uint32Array(target.storage.bytes.buffer)), [0, 0, 0, 0]);
});

test('CObjectManager teardown owns its private workers and preserves an externally shared worker manager', () => {
  const own = setup(),
    shared = setup(16, true);
  assert.equal(own.renderer.ownsProcessing, true);
  assert.equal(shared.renderer.ownsProcessing, false);
  own.manager.dispose();
  shared.manager.dispose();
  assert.equal(own.renderer.processing.alive, false);
  assert.equal(shared.renderer.processing.alive, true);
  shared.renderer.processing.dispose();
});

test('object-manager callbacks preserve same-actor recursive lock ownership across native nesting', () => {
  const {manager, renderer, environment, allocator} = setup();
  const seen = [];
  class Observed extends AokanaDisplayObject {
    sortKey() {
      seen.push(['sort', manager.objectLock.depth]);
      return super.sortKey();
    }
    draw() {
      assert.equal(manager.objectLock.owner, allocator.currentActor);
      seen.push(['draw', manager.objectLock.depth]);
      assert.equal(renderer.collectOrdinary().includes(this), true);
    }
    notify() {
      assert.equal(manager.objectLock.owner, allocator.currentActor);
      seen.push(['notify', manager.objectLock.depth]);
      environment.damage.record(3, rect(3, 3, 3, 3));
    }
  }
  const handle = manager.createSimple('sprite', (order) => new Observed(environment, 1, order, 1));
  const object = manager.resolve(handle);
  object.configureGeometry(4, 4);
  object.setActivation(1);
  assert.deepEqual(seen, [['sort', 1]]);
  seen.length = 0;
  manager.objectLock.run(() => manager.lists.resort(object));
  assert.deepEqual(seen, [['sort', 3]]);
  seen.length = 0;
  renderer.drawDamage();
  assert.deepEqual(
    seen.filter(([kind]) => kind !== 'sort'),
    [
      ['draw', 2],
      ['draw', 2],
      ['notify', 2],
    ],
  );
  assert.equal(manager.objectLock.depth, 0);
  assert.equal(manager.objectLock.owner, null);
  assert.deepEqual(environment.damage.snapshot(), [{rectangle: rect(3, 3, 3, 3), key: 3}]);
  manager.clearObjectLists();
  assert.equal(environment.damage.count, 0);
  assert.equal(manager.objectLock.depth, 0);
});

test('window-local CObjectManager shares the actual traversal with separate descriptor and damage', () => {
  const {manager, environment} = setup();
  const context = {bitmap: bitmap(3, 2), bounds: rect(0, 0, 2, 1)};
  const inner = new AokanaInnerDisplayObjectManager(4, context, manager.surfaces, manager.effectors);
  assert.equal(inner.context, context);
  assert.equal(inner.damage.capacity, 4);
  assert.equal(inner.damage.fullRedraw, 1);
  assert.equal(inner.renderPixelBudget, 0xffffffff);
  assert.equal(inner.renderer.ownsProcessing, true);
  assert.notEqual(inner.objectLock, manager.objectLock);
  manager.setBackdropRenderType(7);
  assert.equal(inner.renderer.canUseStrips(), 1);
  assert.equal(inner.renderer.canDrawDamage(), 1);
  inner.clearDamage(); // 068040 calls 06F380 after the local constructor.
  const calls = [];
  class LocalObject extends AokanaDisplayObject {
    draw(destination, rectangle, key) {
      assert.equal(destination.storage, context.bitmap.storage);
      calls.push(['draw', {...rectangle}, key]);
    }
    notify(...values) {
      calls.push(['notify', ...values, inner.damage.count]);
    }
  }
  const object = new LocalObject(environment, 1, 0, 0);
  object.configureGeometry(3, 2);
  object.setActivation(1);
  inner.lists.insert(object);
  inner.lists.resort(object);
  inner.damage.record(0, rect(0, 0, 2, 1));
  assert.deepEqual(inner.renderer.drawDamage(), {count: 1, rectangles: [rect(0, 0, 2, 1)]});
  assert.deepEqual(calls, [
    ['draw', rect(0, 0, 2, 1), 0],
    ['notify', 0xf0000000, 0, 0, 0],
  ]);
  assert.deepEqual(inner.renderer.collectOrdinary(), [object]);
  assert.deepEqual(manager.lists.snapshot(false).map((entry) => entry.object), [manager.backdrop]);
  assert.equal(inner.lists.remove(object), 1);
  object.dispose();
  inner.dispose();
  assert.equal(inner.renderer.processing.alive, false);
  manager.dispose();
});

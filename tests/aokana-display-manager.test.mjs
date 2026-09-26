import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBitmapStorage} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {
  AokanaBackdrop,
  AokanaNormalBackdrop,
} from '../dist/engines/buriko/games/aokana/native/display-backdrop.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {
  AokanaDisplayObject,
  AokanaDisplayObjectEnvironment,
} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {
  AOKANA_DISPLAY_POOLS,
  AokanaDisplayManager,
} from '../dist/engines/buriko/games/aokana/native/display-manager.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';

const rect = (left, top, right, bottom) => ({left, top, right, bottom});
const bitmap = (width, height, words = []) => ({
  storage: new AokanaBitmapStorage(
    new Uint8Array(
      new Uint32Array(Array.from({length: width * height}, (_, index) => words[index] ?? 0)).buffer,
    ),
    true,
  ),
  offset: 0,
  stride: width * 4,
  width,
  height,
  format: 1,
  bytesPerPixel: 4,
});
const words = (bitmap) => Array.from(new Uint32Array(bitmap.storage.bytes.buffer));
function setup() {
  const compositor = new AokanaBitmapCompositor();
  compositor.defaultFormat = 1;
  const environment = new AokanaDisplayObjectEnvironment(
    compositor,
    new AokanaDisplayDamage(1024, rect(0, 0, 3, 2)),
  );
  const surfaces = new AokanaSurfaces(
    new AokanaNativeFonts(new AokanaNativeText()),
    compositor,
    new AokanaDistributedAllocator(1),
  );
  const state = new AokanaNativeDisplayState(1920, 1080);
  return {compositor, environment, surfaces, state};
}
function managerSetup() {
  const setupResult = setup();
  const manager = new AokanaDisplayManager(
    setupResult.environment,
    setupResult.surfaces,
    setupResult.state,
  );
  return {...setupResult, manager};
}

test('backdrop uses a copied global descriptor and base virtuals during construction', () => {
  const {environment} = setup();
  assert.deepEqual(environment.displayBitmap(), {
    storage: null,
    offset: 0,
    stride: 0,
    width: 0,
    height: 0,
    format: 0,
    bytesPerPixel: 0,
  });
  const empty = new AokanaBackdrop(environment, 1);
  assert.equal(empty.inputActive(), 1);
  assert.equal(empty.bitmap.width, 0);
  environment.displayContext = {bitmap: bitmap(4, 3), bounds: rect(0, 0, 3, 2)};
  const copy = environment.displayBitmap();
  copy.width = 100;
  assert.equal(environment.displayContext.bitmap.width, 4);
  assert.equal(copy.storage, environment.displayContext.bitmap.storage);
  let configured = 0;
  class DerivedBackdrop extends AokanaBackdrop {
    configureGeometry(width, height) {
      configured++;
      return super.configureGeometry(width, height);
    }
    setActivation(value) {
      configured++;
      super.setActivation(value);
    }
  }
  const backdrop = new DerivedBackdrop(environment, 3);
  assert.equal(configured, 0);
  assert.equal(backdrop.bitmap.width, 4);
  assert.equal(backdrop.bitmap.height, 3);
  assert.equal(backdrop.bitmap.format, 1);
  assert.equal(backdrop.resizeToDisplay(), 0);
  environment.displayContext.bitmap.width = 2;
  assert.equal(backdrop.resizeToDisplay(), 1);
  assert.equal(configured, 1);
  backdrop.move(12, 34);
  assert.deepEqual(backdrop.position(), {x: 0, y: 0});
  assert.deepEqual(backdrop.inputRectangle(0), rect(0, 0, 1, 2));
  const reference = rect(3, 4, 9, 10);
  assert.deepEqual(backdrop.inputRectangle(reference), reference);
  assert.notEqual(backdrop.inputRectangle(reference), reference);
});

test('backdrop clear/content paths affect only the supplied destination descriptor', () => {
  const {environment} = setup();
  const backdrop = new AokanaBackdrop(environment, 1);
  const target = bitmap(4, 2, [1, 2, 3, 4, 5, 6, 7, 8]);
  backdrop.draw({...target, offset: 4, width: 2}, rect(1, 0, 2, 1), 0);
  assert.deepEqual(words(target), [1, 0, 0, 4, 5, 0, 0, 8]);
  backdrop.invalidate();
  assert.equal(environment.damage.fullRedraw, 0);
  backdrop.setContentEnabled(2);
  backdrop.invalidate();
  assert.equal(environment.damage.fullRedraw, 1);
  target.storage.bytes.fill(8);
  backdrop.draw(target, rect(0, 0, 3, 1), 0);
  assert.deepEqual(words(target), Array(8).fill(0));
});

test('normal backdrop selects matching geometry and retains the selected surface image identity', () => {
  const {environment, surfaces} = setup();
  environment.displayContext = {bitmap: bitmap(4, 3), bounds: rect(0, 0, 3, 2)};
  const backdrop = new AokanaNormalBackdrop(environment, surfaces);
  assert.equal(surfaces.allocate(7, 4, 3, 1), 1);
  const source = surfaces.descriptor(7);
  source.storage.view.setUint32(5 * 4, 0x112233, true);
  source.storage.view.setUint32(6 * 4, 0x445566, true);
  source.storage.view.setUint32(9 * 4, 0x778899, true);
  source.storage.view.setUint32(10 * 4, 0xaabbcc, true);
  source.storage.written(0, 48);
  assert.equal(backdrop.setSurface(7), 1);
  assert.equal(surfaces.allocate(8, 3, 3, 1), 1);
  assert.equal(backdrop.setSurface(8), 0);
  assert.equal(backdrop.surface, 7);
  const target = bitmap(2, 2);
  assert.equal(backdrop.drawContent(target, rect(1, 1, 2, 2)), 1);
  assert.deepEqual(words(target), [0x112233, 0x445566, 0x778899, 0xaabbcc]);
  assert.equal(surfaces.allocate(7, 4, 3, 1), 1);
  assert.equal(backdrop.drawContent(target, rect(1, 1, 2, 2)), 0);
  assert.equal(backdrop.setSurface(7), 1);
});

test('shared pools preserve first-empty reuse, independent counters and all handle categories', () => {
  const {manager, environment} = managerSetup();
  const orders = [];
  const construct = (order) => {
    orders.push(order);
    return new AokanaDisplayObject(environment, 1, order, 1);
  };
  const first = manager.createSimple('sprite', construct);
  const second = manager.createSimple('sprite', construct);
  assert.deepEqual([first, second], [0x80000000, 0x80000001]);
  assert.equal(manager.categoryCount(0), 2);
  assert.equal(manager.destroy('sprite', first), true);
  assert.equal(manager.createSimple('sprite', construct), first);
  assert.deepEqual(orders, [0, 1, 2]);
  assert.equal(manager.creationCount('sprite'), 3);
  assert.equal(manager.resolve(second), manager.find('sprite', second));
  assert.equal(manager.resolve(0), manager.backdrop);
  assert.equal(manager.find('rain', second), null);
  assert.equal(manager.resolve(0x80000800), null);
  assert.equal(manager.categoryCount(8), 0xffffffff);
  for (const [family, definition] of Object.entries(AOKANA_DISPLAY_POOLS)) {
    if (family === 'sprite') continue;
    const create = ['window', 'particle', 'rain'].includes(family)
      ? manager.createConfigured(family, construct, () => (family === 'rain' ? 0 : 1)).handle
      : family === 'knob'
        ? manager.createKnob(0, construct).handle
        : manager.createSimple(family, construct);
    assert.equal(create, definition.prefix);
    assert.equal(manager.categoryCount(definition.category), 1);
    assert.equal(manager.resolve(create), manager.find(family, create));
  }
  const listed = manager.lists.snapshot(false).map((entry) => entry.object);
  assert.equal(listed.includes(manager.find('group', 0xf1000000)), false);
  assert.equal(listed.includes(manager.find('knob', 0xf0000000)), false);
  manager.dispose();
});

test('simple and configured pools expose their native count at list insertion', () => {
  const {manager, environment} = managerSetup();
  const seen = [];
  class Observed extends AokanaDisplayObject {
    constructor(family, category, order) {
      super(environment, 1, order, 1);
      this.family = family;
      this.poolCategory = category;
      seen.push(['construct', family, order, manager.creationCount(family)]);
    }
    sortKey() {
      seen.push(['insert', this.family, manager.categoryCount(this.poolCategory), this.handle]);
      return super.sortKey();
    }
  }
  manager.createSimple('filter', (order) => new Observed('filter', 1, order));
  manager.createConfigured(
    'rain',
    (order) => new Observed('rain', 7, order),
    (object) => {
      seen.push(['configure', manager.categoryCount(7), object.handle]);
      return 0;
    },
  );
  assert.deepEqual(seen, [
    ['construct', 'filter', 0, 1],
    ['insert', 'filter', 0, 0],
    ['construct', 'rain', 0, 1],
    ['configure', 0, 0],
    ['insert', 'rain', 1, 0],
  ]);
});

test('rain capacity is checked before construction and count declines after ordinary removal', () => {
  const {manager, environment} = managerSetup();
  let constructed = 0;
  const construct = (order) => {
    constructed++;
    return new AokanaDisplayObject(environment, 7, order, 1);
  };
  for (let index = 0; index < 8; index++)
    assert.deepEqual(
      manager.createConfigured('rain', construct, () => 0),
      {result: 0, handle: 0xc1000000 + index},
    );
  assert.deepEqual(
    manager.createConfigured('rain', construct, () => 0),
    {result: 1},
  );
  assert.equal(constructed, 8);
  assert.equal(manager.creationCount('rain'), 8);
  assert.equal(manager.destroy('rain', 0xc1000003), true);
  assert.equal(manager.categoryCount(7), 7);
  assert.deepEqual(
    manager.createConfigured('rain', construct, () => 0),
    {result: 0, handle: 0xc1000003},
  );
});

test('pool destruction uses the effector full-redraw rule and skips drawing operations for groups', () => {
  const {manager, environment} = managerSetup();
  const calls = [];
  class Observed extends AokanaDisplayObject {
    constructor(family, order) {
      super(environment, 1, order, 1);
      this.family = family;
    }
    inputActive() {
      calls.push(['visible', this.family]);
      return 1;
    }
    invalidate() {
      calls.push(['invalidate', this.family]);
    }
    dispose() {
      calls.push(['dispose', this.family, manager.find(this.family, this.handle) === this]);
      super.dispose();
    }
  }
  for (const family of ['filter', 'effector', 'group']) {
    const handle = manager.createSimple(family, (order) => new Observed(family, order));
    environment.damage.clear();
    manager.destroy(family, handle);
    assert.equal(environment.damage.fullRedraw, family === 'effector' ? 1 : 0);
  }
  assert.deepEqual(calls, [
    ['visible', 'filter'],
    ['invalidate', 'filter'],
    ['dispose', 'filter', true],
    ['visible', 'effector'],
    ['dispose', 'effector', true],
    ['dispose', 'group', true],
  ]);
});

test('generic activation and movement preserve zero transitions and initial move visibility', () => {
  const {manager, environment} = managerSetup();
  const calls = [];
  class Observed extends AokanaDisplayObject {
    invalidate() {
      calls.push('invalidate');
    }
    setSecondaryVisibility() {
      calls.push('override-secondary');
    }
    move(x, y) {
      calls.push(['move', x, y]);
      this.activation = 0;
      super.move(x, y);
    }
  }
  const handle = manager.createSimple('sprite', (order) => new Observed(environment, 1, order, 1));
  manager.setActivation(handle, 2);
  manager.setActivation(handle, 3);
  manager.setSecondaryVisibility(handle, 0);
  manager.setSecondaryVisibility(handle, 1);
  manager.move(handle, 7, 9);
  assert.deepEqual(calls, [
    'invalidate',
    'invalidate',
    'invalidate',
    'invalidate',
    ['move', 7, 9],
    'invalidate',
  ]);
  assert.deepEqual(manager.resolve(handle).position(), {x: 7, y: 9});
  manager.setOrigin(4, 5);
  manager.setReferencePoint(8, 9);
  assert.deepEqual(environment.origin, {x: 4, y: 5});
  assert.deepEqual(manager.referencePoint, {x: 8, y: 9});
  assert.equal(manager.redraw.pending, 0);
  assert.equal(environment.damage.fullRedraw, 1);
});

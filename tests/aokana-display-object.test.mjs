import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BurikoDisplayObject,
  BurikoDisplayObjectEnvironment,
} from '../dist/engines/buriko/native/display-object.js';
import {BurikoDisplayObjectLists} from '../dist/engines/buriko/native/display-object-lists.js';
import {
  BurikoDisplayDamage,
  BurikoDisplayDamageLifetimeError,
} from '../dist/engines/buriko/native/display-damage.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoBitmapStorage} from '../dist/engines/buriko/native/bitmap.js';
import {BurikoMemoryDx} from '../dist/engines/buriko/native/memory-dx.js';
const rect = (left, top, right, bottom) => ({left, top, right, bottom});
const environment = () =>
  new BurikoDisplayObjectEnvironment(
    new BurikoBitmapCompositor(),
    new BurikoDisplayDamage(64, rect(-1000, -1000, 1000, 1000)),
  );
const object = (env = environment(), category = 0) => new BurikoDisplayObject(env, category, 0, 1);

test('CMemoryDX retains allocation ownership independently of descriptor geometry', () => {
  const memory = new BurikoMemoryDx();
  const zero = memory.allocate(0);
  assert.ok(zero);
  assert.equal(memory.active, 1);
  assert.equal(memory.allocate(12), null);
  assert.equal(memory.free(), 1);
  assert.equal(memory.free(), 0);
  assert.throws(() => zero.range(0, 0, false), /released/);
  memory.dispose();
  assert.throws(() => memory.allocate(1), /deleted/);
  const env = environment(),
    obj = object(env);
  const allocation = obj.memory.allocate(16);
  obj.bitmap.storage = allocation;
  assert.equal(obj.configureGeometry(-2, 3), 1);
  assert.equal(obj.bitmap.stride, -4);
  assert.equal(obj.bitmap.storage, null);
  assert.equal(obj.memory.allocation, allocation);
  env.compositor.defaultFormat = 9;
  obj.bitmap.storage = allocation;
  assert.throws(() => obj.configureGeometry(8, 9), /pixel-size/);
  assert.equal(obj.bitmap.width, 8);
  assert.equal(obj.bitmap.height, 9);
  assert.equal(obj.bitmap.format, 9);
  assert.equal(obj.bitmap.storage, allocation);
});

test('base visibility, masked propagation, and child virtual dispatch preserve separate switches', () => {
  const env = environment();
  const parent = object(env);
  let activated = 0,
    secondary = 0;
  class Child extends BurikoDisplayObject {
    setActivation(v) {
      activated++;
      super.setActivation(v);
    }
    setSecondaryVisibility(v) {
      secondary++;
      super.setSecondaryVisibility(v);
    }
  }
  const child = new Child(env, 0, 0, 1);
  parent.addChild(child, 3, 4);
  assert.equal(parent.inputActive(), 0);
  parent.setActivation(1);
  assert.equal(activated, 1);
  assert.equal(child.inputActive(), 1);
  parent.setSecondaryVisibility(0);
  assert.equal(child.inputActive(), 1);
  parent.propagateSecondaryVisibility = 1;
  parent.setSecondaryVisibility(0);
  assert.equal(secondary, 0);
  assert.equal(child.inputActive(), 0);
  parent.setSecondaryVisibility(1);
  child.setMaskedFlags(1, 0);
  parent.setTransparency(256);
  assert.equal(parent.inputActive(), 0);
  assert.equal(child.transparency, 0);
  assert.equal(child.inputActive(), 1);
  child.setOpacityScale(0);
  assert.equal(child.inputActive(), 0);
});

test('child relative offsets are updated by explicit moves and parent movement propagates', () => {
  const env = environment(),
    parent = object(env),
    child = object(env),
    other = object(env);
  parent.move(10, 20);
  assert.equal(parent.addChild(child, 3, -4), 1);
  assert.deepEqual(child.position(), {x: 13, y: 16});
  child.move(30, 40);
  parent.move(100, 200);
  assert.deepEqual(child.position(), {x: 120, y: 220});
  assert.equal(other.addChild(child, 1, 1), 0);
  assert.equal(parent.removeChild(child), 1);
  assert.equal(child.parent, null);
  assert.equal(other.addChild(child, 1, 1), 1);
  other.dispose();
  assert.equal(child.parent, null);
  assert.equal(child.inputActive(), 0);
});

test('Q16 coordinate rounding, secondary offsets, and global point remain independent', () => {
  const env = environment(),
    obj = object(env);
  obj.coordinateRounding = 1;
  obj.setCoordinates(0x18000, -0x8000, 0);
  assert.deepEqual(obj.coordinates(), {x: 0x20000, y: 0, z: 0});
  obj.setCoordinates(0x18000, -0x8000, 1);
  assert.deepEqual(obj.position(), {x: 1, y: -1});
  obj.setOffset(7, 8);
  obj.setSecondaryOffset(-1, -2);
  env.origin.x = 30;
  env.origin.y = 40;
  assert.deepEqual(obj.effectivePosition(), {x: 37, y: 45});
  obj.usesGlobalOrigin = 0;
  assert.deepEqual(obj.effectivePosition(), {x: 7, y: 5});
  obj.setCoordinateOffset(1, 2, 3);
  obj.setSecondaryCoordinateOffset(4, 5, 6);
  assert.deepEqual(obj.effectiveCoordinates(), {x: 0x18005, y: -0x7ff9, z: 10});
});

test('invalidated parents recurse even without their own nonzero stride', () => {
  const env = environment(),
    parent = object(env),
    child = object(env);
  parent.addChild(child, 4, 5);
  child.configureGeometry(2, 3);
  parent.invalidate();
  assert.deepEqual(env.damage.snapshot(), [{rectangle: rect(4, 5, 5, 7), key: 0}]);
});

test('hit masks retain native format tests and raw bit return values', () => {
  const obj = object();
  obj.configureGeometry(9, 1);
  const bytes = new Uint8Array(36);
  const view = new DataView(bytes.buffer);
  view.setUint32(7 * 4, 0x10000000, true);
  view.setUint32(8 * 4, 0x00112233, true);
  const source = {
    storage: new BurikoBitmapStorage(bytes, true),
    offset: 0,
    stride: 36,
    width: 9,
    height: 1,
    format: 2,
    bytesPerPixel: 4,
  };
  obj.setHitMask(source);
  assert.equal(obj.inputHitTest(7, 0, 1), 128);
  assert.equal(obj.inputHitTest(8, 0, 1), 0);
  source.format = 1;
  obj.setHitMask(source);
  assert.equal(obj.inputHitTest(7, 0, 1), 0);
  assert.equal(obj.inputHitTest(8, 0, 1), 1);
  assert.equal(obj.inputHitTest(-1, 0, 0), 0);
  obj.setHitMask(null);
  assert.equal(obj.inputHitTest(100, 0, 0), 1);
  assert.equal(obj.inputHitTest(100, 0, 1), 0);
});

test('property return codes and unwritten field124 are not converted to invented values', () => {
  const obj = object();
  const output = new Uint32Array([123]);
  assert.equal(obj.getProperty(99, output), 0xffff0001);
  assert.equal(output[0], 123);
  assert.equal(obj.setProperty(0x8101, 2, 0), 0xffff0002);
  assert.equal(obj.setProperty(0x7fffffff, 16, 3), 0xffff0002);
  assert.equal(obj.setProperty(0x7fffffff, 15, 0xabcdef01), 0);
  output[0] = 15;
  assert.equal(obj.getProperty(0x7fffffff, output), 0);
  assert.equal(output[0], 0xabcdef01);
  assert.throws(() => obj.getProperty(0xffffffff, output), /unwritten/);
  obj.value124 = 23;
  obj.getProperty(0xffffffff, output);
  assert.equal(output[0], 23);
  assert.throws(() => obj.getProperty(0, new Uint32Array(1)), /outside/);
});

test('draw wrapper crops actual target bytes and translates its virtual draw rectangle to object-local coordinates', () => {
  const env = environment();
  let invocation;
  class Draw extends BurikoDisplayObject {
    draw(bitmap, rectangle, key) {
      invocation = {bitmap, rectangle: {...rectangle}, key};
    }
  }
  const obj = new Draw(env, 0, 0, 1);
  obj.configureGeometry(4, 4);
  obj.move(10, 20);
  obj.setActivation(1);
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
    bounds: rect(10, 20, 13, 23),
  };
  assert.equal(obj.drawClipped(context, rect(11, 21, 12, 22), 77, context), 0);
  assert.equal(invocation.bitmap.offset, 20);
  assert.equal(invocation.bitmap.width, 2);
  assert.equal(invocation.bitmap.height, 2);
  assert.deepEqual(invocation.rectangle, rect(1, 1, 2, 2));
  assert.equal(invocation.key, 77);
});

test('ordinary list keys are unsigned and stable with duplicate objects', () => {
  const env = environment(),
    lists = new BurikoDisplayObjectLists(),
    a = object(env),
    b = object(env),
    c = object(env);
  a.sortBias = -1;
  b.sortBias = 0;
  c.sortBias = 0;
  lists.insert(a);
  lists.insert(b);
  lists.insert(c);
  lists.insert(b);
  assert.deepEqual(
    lists.snapshot(false).map((n) => n.object),
    [b, c, b, a],
  );
  assert.equal(lists.remove(b), 1);
  assert.deepEqual(
    lists.snapshot(false).map((n) => n.object),
    [c, b, a],
  );
  lists.clear();
  assert.deepEqual(lists.snapshot(false), []);
  assert.equal(a.inputActive(), 0);
});

test('expanded lists retain root order and insertion cursor even for descending input keys', () => {
  const env = environment(),
    lists = new BurikoDisplayObjectLists();
  class Expanded extends BurikoDisplayObject {
    hasExpandedSortKeys() {
      return 1;
    }
  }
  const a = new Expanded(env, 0, 0, 1),
    b = new Expanded(env, 0, 0, 1);
  a.replaceExpandedSortKeys(Uint32Array.of(10, 1));
  lists.insert(a);
  assert.deepEqual(
    lists.snapshot(true).map((n) => n.key),
    [10, 1],
  );
  b.replaceExpandedSortKeys(Uint32Array.of(1, 10));
  lists.insert(b);
  assert.deepEqual(
    lists.snapshot(true).map((n) => [n.key, n.object === a ? 'a' : 'b']),
    [
      [1, 'b'],
      [10, 'b'],
      [10, 'a'],
      [1, 'a'],
    ],
  );
  assert.equal(lists.remove(b), 1);
  assert.deepEqual(
    lists.snapshot(true).map((n) => n.key),
    [10, 1],
  );
});

test('resort returns child removal failure after successfully reinserting its parent', () => {
  const env = environment(),
    lists = new BurikoDisplayObjectLists(),
    parent = object(env),
    child = object(env);
  parent.addChild(child, 0, 0);
  lists.insert(parent);
  assert.equal(lists.resort(parent), 0);
  assert.equal(lists.snapshot(false)[0].object, parent);
  lists.insert(child);
  assert.equal(lists.resort(parent), 1);
});

test('damage clips the caller in place and capacity preserves earlier nodes', () => {
  const damage = new BurikoDisplayDamage(1, rect(0, 0, 9, 9));
  const first = rect(-2, 2, 4, 4);
  damage.record(9, first);
  assert.deepEqual(first, rect(0, 2, 4, 4));
  const second = rect(-2, -2, 20, 20);
  damage.record(1, second);
  assert.deepEqual(second, rect(-2, -2, 20, 20));
  assert.equal(damage.fullRedraw, 1);
  assert.equal(damage.count, 1);
  damage.clear();
  damage.capacity = 10;
  damage.record(9, rect(0, 0, 5, 5));
  damage.record(1, rect(1, 1, 2, 2));
  assert.equal(damage.snapshot()[0].key, 9);
  damage.record(3, rect(6, 0, 9, 5));
  assert.deepEqual(damage.snapshot(), [{rectangle: rect(0, 0, 9, 5), key: 3}]);
});

test('failed hit-mask construction retains row clearing order and unwritten future rows', () => {
  const obj = object();
  const source = {
    storage: new BurikoBitmapStorage(Uint8Array.of(1), true),
    offset: 0,
    stride: 1,
    width: 1,
    height: 3,
    format: 3,
    bytesPerPixel: 1,
  };
  assert.throws(() => obj.setHitMask(source), /outside/);
  assert.equal(obj.inputHitTest(0, 0, 0), 1);
  assert.equal(obj.inputHitTest(0, 1, 0), 0);
  assert.throws(() => obj.inputHitTest(0, 2, 0), /unwritten/);
});

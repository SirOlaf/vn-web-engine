import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBitmapStorage} from '../dist/engines/buriko/native/bitmap.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoDisplayDamage} from '../dist/engines/buriko/native/display-damage.js';
import {
  BurikoDisplayObject,
  BurikoDisplayObjectEnvironment,
} from '../dist/engines/buriko/native/display-object.js';
import {BurikoVirtualDisplayObject} from '../dist/engines/buriko/native/display-virtual.js';

function environment() {
  const compositor = new BurikoBitmapCompositor();
  compositor.defaultFormat = 1;
  return new BurikoDisplayObjectEnvironment(
    compositor,
    new BurikoDisplayDamage(32, {left: 0, top: 0, right: 799, bottom: 599}),
  );
}
const mask = (width, height, bytes) => ({
  storage: new BurikoBitmapStorage(Uint8Array.from(bytes), true),
  offset: 0,
  stride: width,
  width,
  height,
  format: 3,
  bytesPerPixel: 1,
});

test('virtual object construction only sets the native parent pointer and forwards its three query virtuals', () => {
  const env = environment();
  class Parent extends BurikoDisplayObject {
    sortKey() {
      return 0xffffc000;
    }
  }
  const parent = new Parent(env, 2, 7, 1);
  parent.layer = 4;
  parent.setActivation(1);
  const child = new BurikoVirtualDisplayObject(env, 3, parent);
  assert.deepEqual(
    [child.category, child.depthOrder, child.value120, child.value170],
    [8, 3, 1, 1],
  );
  assert.equal(child.parent, parent);
  assert.deepEqual(Array.from(parent.children()), []);
  assert.equal(child.activation, 0);
  assert.equal(child.inputActive(), 1);
  assert.equal(child.sortKey(), 0x4000);
  assert.equal(child.getLayer(), 4);
  parent.setActivation(0);
  child.setActivation(1);
  assert.equal(child.inputActive(), 0);
  child.setValue170(0xffffffff);
  assert.equal(child.value170, 0xffffffff);
  child.parent = null;
  child.layer = 2;
  assert.equal(child.inputActive(), 1);
  assert.equal(child.getLayer(), 2);
  assert.equal(child.sortKey(), 0x2e003);
});

test('virtual hit testing rescales the child mask then preserves original coordinates in its parent', () => {
  const env = environment(),
    parent = new BurikoDisplayObject(env, 2, 0, 1);
  parent.configureGeometry(8, 8);
  parent.move(100, 200);
  const parentBytes = new Uint8Array(64);
  parentBytes[5] = 1;
  parent.setHitMask(mask(8, 8, parentBytes));
  const child = new BurikoVirtualDisplayObject(env, 0, parent);
  child.configureGeometry(4, 4);
  child.move(102, 199);
  child.setHitMask(mask(2, 2, [0, 1, 0, 0]));
  env.origin.x = 20;
  env.origin.y = 30;
  parent.setOffset(50, 60);
  child.setSecondaryOffset(-100, -200);
  child.usesGlobalOrigin = 0;
  // (3,1) scales to child mask (1,0), then reaches parent position (5,0).
  assert.equal(child.inputHitTest(3, 1, 1), 0x20);
  assert.equal(child.inputHitTest(0, 1, 1), 0);
  assert.equal(child.inputHitTest(3, 3, 1), 0);
  child.parent = null;
  assert.equal(child.inputHitTest(3, 1, 1), 1);
});

test('virtual objects retain the native empty base draw instead of painting a forwarded parent', () => {
  const env = environment();
  let draws = 0;
  class Parent extends BurikoDisplayObject {
    draw() {
      draws++;
    }
  }
  const parent = new Parent(env, 2, 0, 1),
    child = new BurikoVirtualDisplayObject(env, 0, parent);
  const target = mask(2, 2, [7, 8, 9, 10]);
  child.draw(target, {left: 0, top: 0, right: 1, bottom: 1}, 0);
  assert.equal(draws, 0);
  assert.deepEqual(Array.from(target.storage.bytes), [7, 8, 9, 10]);
});

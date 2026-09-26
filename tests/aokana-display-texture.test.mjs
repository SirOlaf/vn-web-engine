import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaDisplayTexture} from '../dist/engines/buriko/games/aokana/native/display-texture.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {
  AokanaDisplayObject,
  AokanaDisplayObjectEnvironment,
} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaDisplayManager} from '../dist/engines/buriko/games/aokana/native/display-manager.js';
import {AokanaDisplayRenderer} from '../dist/engines/buriko/games/aokana/native/display-renderer.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';

function setup() {
  const compositor = new AokanaBitmapCompositor();
  const environment = new AokanaDisplayObjectEnvironment(
    compositor,
    new AokanaDisplayDamage(64, {left: 0, top: 0, right: 3, bottom: 3}),
  );
  const allocator = new AokanaDistributedAllocator(1);
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
  const renderer = new AokanaDisplayRenderer(manager, 16);
  return {environment, manager, renderer};
}

test('descriptor reconfiguration preserves shared identity and native family traversal order', () => {
  const {environment, manager} = setup();
  manager.configureDescriptor(4, 4, 1, 16);
  const context = environment.displayContext;
  const calls = [];
  const resized = (family) =>
    class extends AokanaDisplayObject {
      resizeToDisplay() {
        calls.push([
          family,
          environment.displayBitmap().width,
          manager.renderPixelBudget,
          environment.compositor.defaultFormat,
        ]);
        return 1;
      }
    };
  const Filter = resized('filter'),
    Effector = resized('effector');
  manager.createSimple('filter', (order) => new Filter(environment, 3, order, 1));
  manager.createSimple('effector', (order) => new Effector(environment, 6, order, 1));
  class Window extends AokanaDisplayObject {
    refreshDisplayGeometry() {
      calls.push(['window', environment.displayBitmap().width]);
    }
  }
  manager.createConfigured(
    'window',
    (order) => new Window(environment, 4, order, 1),
    () => 1,
  );
  assert.equal(manager.configureDescriptor(6, 3, 2, 18), 1);
  assert.equal(environment.displayContext, context);
  assert.equal(environment.damage.clip, context.bounds);
  assert.deepEqual(context.bounds, {left: 0, top: 0, right: 5, bottom: 2});
  assert.deepEqual(context.bitmap, {
    storage: null,
    offset: 0,
    stride: 0,
    width: 6,
    height: 3,
    format: 2,
    bytesPerPixel: 4,
  });
  assert.deepEqual(calls, [
    ['filter', 6, 18, 2],
    ['effector', 6, 18, 2],
    ['window', 6],
  ]);
  assert.equal(environment.damage.fullRedraw, 1);
});

test('normal full and damage draw notifications observe the one mapped display descriptor', () => {
  const {environment, manager} = setup();
  manager.configureDescriptor(4, 3, 1, 12);
  const texture = new AokanaDisplayTexture(8, 4, 22);
  texture.clearLogical(4, 3);
  manager.setDisplayTexture(texture);
  const seen = [];
  class Observed extends AokanaDisplayObject {
    notify() {
      seen.push([
        environment.displayContext.bitmap.storage === texture.storage,
        environment.displayContext.bitmap.stride,
      ]);
    }
  }
  manager.createSimple('sprite', (order) => new Observed(environment, 1, order, 1));
  assert.equal(manager.drawFull(), 1);
  assert.deepEqual(seen, [[true, 32]]);
  assert.equal(environment.displayContext.bitmap.storage, null);
  assert.equal(environment.displayContext.bitmap.stride, 0);
  environment.damage.record(2, {left: 1, top: 1, right: 2, bottom: 1});
  const output = {count: 0, rectangles: []};
  assert.equal(manager.drawDamage(output), 1);
  assert.deepEqual(output, {count: 1, rectangles: [{left: 1, top: 1, right: 2, bottom: 1}]});
  assert.deepEqual(seen, [
    [true, 32],
    [true, 32],
  ]);
  assert.equal(environment.displayContext.bitmap.storage, null);
});

test('level-zero dirty updates preserve unselected sample texels after the initial upload', () => {
  const source = new AokanaDisplayTexture(4, 2, 22);
  const target = new AokanaDisplayTexture(4, 2, 22);
  target.updateFrom(source);
  const locked = source.lock();
  locked.storage.view.setUint32(4, 0x00112233, true);
  locked.storage.view.setUint32(8, 0x00445566, true);
  source.unlock();
  source.addDirtyRectangle({left: 1, top: 0, right: 1, bottom: 0});
  target.updateFrom(source);
  assert.equal(target.storage.view.getUint32(4, true), 0x00112233);
  assert.equal(target.storage.view.getUint32(8, true), 0);
  source.addDirtyRectangle({left: 2, top: 0, right: 2, bottom: 0});
  target.updateFrom(source);
  assert.equal(target.storage.view.getUint32(8, true), 0x00445566);
});

import {AokanaMapDisplays} from '../dist/engines/buriko/games/aokana/native/map-displays.js';
import {AokanaDisplayLandscape} from '../dist/engines/buriko/games/aokana/native/display-landscape.js';
import {AokanaGroupDisplays} from '../dist/engines/buriko/games/aokana/native/group-displays.js';
import {bitmapWrite32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {createGroup92ObjectLifecycle} from '../dist/engines/buriko/games/aokana/native/group-92-object-lifecycle.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaBitmapStorage} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {AokanaDisplayManager} from '../dist/engines/buriko/games/aokana/native/display-manager.js';
import {AokanaDisplayObjectEnvironment} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaDisplayRenderer} from '../dist/engines/buriko/games/aokana/native/display-renderer.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';

const rectangle = (left, top, right, bottom) => ({left, top, right, bottom});
const bitmap = (width, height, values = []) => ({
  storage: new AokanaBitmapStorage(
    new Uint8Array(
      new Uint32Array(Array.from({length: width * height}, (_, index) => values[index] ?? 0))
        .buffer,
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

function fixture() {
  const compositor = new AokanaBitmapCompositor();
  compositor.defaultFormat = 1;
  const bounds = rectangle(0, 0, 7, 3),
    output = bitmap(8, 4),
    environment = new AokanaDisplayObjectEnvironment(
      compositor,
      new AokanaDisplayDamage(16, {...bounds}),
    );
  environment.displayContext = {bitmap: output, bounds};
  const allocator = new AokanaDistributedAllocator(2),
    text = new AokanaNativeText(),
    surfaces = new AokanaSurfaces(new AokanaNativeFonts(text), compositor, allocator),
    manager = new AokanaDisplayManager(
      environment,
      surfaces,
      new AokanaNativeDisplayState(1920, 1080),
    );
  return {allocator, compositor, environment, manager, output, surfaces, text};
}

test('generic destruction updates the real scene and both category-one pools', () => {
  const {allocator, manager, surfaces, output, environment} = fixture();
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread, memory: new AokanaBpMemory(new Uint8Array(16)), diagnostics: {}};
  const [slot] = createGroup92ObjectLifecycle(manager);
  assert.equal(slot.secondary, 0x31);
  assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x92][0x31]);
  const remove = (handle) => {
    push32(thread, handle);
    assert.equal(slot.execute(context), 0);
    assert.equal(pop32(thread), 1);
    assert.equal(thread.stackIndex, 0);
  };
  assert.equal(surfaces.allocate(0, 2, 1, 1), 1);
  bitmapWrite32(surfaces.snapshot(0), 0, 0x204060);
  bitmapWrite32(surfaces.snapshot(0), 4, 0x6080a0);
  const removedHandle = manager.createSprite(),
    survivorHandle = manager.createSprite();
  for (const [handle, x] of [
    [removedHandle, 1],
    [survivorHandle, 4],
  ]) {
    const sprite = manager.find('sprite', handle);
    assert.equal(sprite.initializeSimple(x, 1, 0, 0, 0, 3), 0);
    sprite.setActivation(1);
  }
  const renderer = new AokanaDisplayRenderer(
    manager,
    1024,
    new AokanaDistributedProcessing(allocator, 2),
  );
  const row = () =>
    Array.from({length: 8}, (_, x) => output.storage.view.getUint32(output.stride + x * 4, true));
  renderer.drawFull();
  assert.deepEqual(row(), [0, 0x204060, 0x6080a0, 0, 0x204060, 0x6080a0, 0, 0]);
  remove(removedHandle);
  renderer.drawFull();
  assert.deepEqual(row(), [0, 0, 0, 0, 0x204060, 0x6080a0, 0, 0]);
  assert.equal(manager.categoryCount(0), 1);

  const maps = new AokanaMapDisplays(manager),
    mapHandle = maps.create();
  assert.equal(maps.configureGrid(mapHandle, 1, 1, 2, 1), 0);
  assert.equal(maps.configure(mapHandle, 0, 0, 0, 0x80, 0, 2), 0);
  assert.equal(
    maps.replaceMap(mapHandle, 1, 1, () => new Uint8Array([0, 0])),
    0,
  );
  assert.equal(maps.selectView(mapHandle, 0, 0, 0, 0, 0), 0);
  const landscapeHandle = manager.createSimple('landscape', (order) => {
    const landscape = new AokanaDisplayLandscape(environment, surfaces, order, 2, 1, 1, 2, 1, 1);
    assert.equal(landscape.configure(0, 0, 0x80, 0, 2), 0);
    const chip = [0, 0, 2, 1, 0],
      recipe = new Uint32Array(34);
    recipe[0] = recipe[33] = 1;
    assert.equal(
      landscape.loadTerrain(
        0,
        1,
        (i) => chip[i],
        1,
        1,
        (i) => recipe[i],
      ),
      0,
    );
    assert.equal(
      landscape.replaceCells(1, 1, () => 0),
      0,
    );
    return landscape;
  });
  assert.equal(manager.categoryCount(3), 1);
  assert.equal(manager.categoryCount(4), 1);
  remove(landscapeHandle);
  assert.equal(manager.categoryCount(4), 0);
  assert.equal(manager.categoryCount(3), 1);
  remove(mapHandle);
  assert.equal(manager.categoryCount(3), 0);
  const groups = new AokanaGroupDisplays(manager),
    groupHandle = groups.create();
  assert.equal(groups.configure(groupHandle, 2, 1, 0), true);
  remove(groupHandle);
  assert.equal(manager.categoryCount(0x11), 0);
  assert.deepEqual(
    manager.lists.snapshot(false).map((entry) => entry.object.handle),
    [0, survivorHandle],
  );
});

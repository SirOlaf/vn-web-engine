import {bitmapWrite32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {createGroup91ObjectCoordinates} from '../dist/engines/buriko/games/aokana/native/group-91-object-coordinates.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
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

test('object coordinate services preserve real child links, suppression and caller position output', () => {
  const {allocator, manager, surfaces, output, text} = fixture();
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 32,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const memory = new AokanaBpMemory(new Uint8Array(16));
  const context = {thread, memory, diagnostics: {}};
  const slots = createGroup91ObjectCoordinates(manager, {
    files: {text},
    threadFatal() {
      assert.fail('ordinary object coordinate operation must succeed');
    },
  });
  assert.deepEqual(
    slots.map((slot) => slot.secondary),
    [0x31, 0x33, 0x36, 0x37, 0x3d, 0x3e, 0x3f],
  );
  for (const slot of slots)
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x91][slot.secondary]);
  const call = (secondary, args) => {
    args.forEach((value) => push32(thread, value));
    assert.equal(slots.find((slot) => slot.secondary === secondary).execute(context), 0);
    assert.equal(thread.stackIndex, 0);
  };
  assert.equal(surfaces.allocate(0, 2, 1, 1), 1);
  bitmapWrite32(surfaces.snapshot(0), 0, 0x204060);
  bitmapWrite32(surfaces.snapshot(0), 4, 0x6080a0);
  const parentHandle = manager.createSprite(),
    childHandle = manager.createSprite();
  const parent = manager.find('sprite', parentHandle),
    child = manager.find('sprite', childHandle);
  for (const sprite of [parent, child]) {
    assert.equal(sprite.initializeSimple(0, 0, 0, 0, 0, 3), 0);
    sprite.setActivation(1);
  }
  assert.equal(parent.setProperty(0x8101, 1, 0), 0);
  assert.equal(parent.setProperty(0xc1, 1, 0), 0);
  call(0x33, [parentHandle, 1 << 16, 1 << 16, 2 << 16]);
  call(0x37, [parentHandle, 3 << 16, 4 << 16, 5 << 16]);
  call(0x36, [parentHandle, 6 << 16, 7 << 16, 8 << 16]);
  assert.deepEqual(parent.effectiveCoordinates(), {x: 10 << 16, y: 12 << 16, z: 15 << 16});
  assert.equal(
    manager.lists.snapshot(false).find((entry) => entry.object === parent).key,
    parent.sortKey(),
  );
  call(0x3e, [parentHandle, childHandle, 3, 0]);
  assert.equal(child.parent, parent);
  assert.deepEqual(Array.from(parent.children()), [child]);
  const point = (handle) => {
    call(0x3d, [4, handle]);
    const view = new DataView(memory.globalMemory.buffer);
    return [view.getInt32(4, true), view.getInt32(8, true)];
  };
  assert.deepEqual(point(parentHandle), [1, 1]);
  assert.deepEqual(point(childHandle), [4, 1]);
  const renderer = new AokanaDisplayRenderer(
    manager,
    1024,
    new AokanaDistributedProcessing(allocator, 2),
  );
  renderer.drawFull();
  const row = () =>
    Array.from({length: 8}, (_, x) => output.storage.view.getUint32(output.stride + x * 4, true));
  assert.deepEqual(row(), [0, 0x204060, 0x6080a0, 0, 0x204060, 0x6080a0, 0, 0]);
  call(0x31, [parentHandle, 1]);
  assert.equal(parent.inputActive(), 0);
  assert.equal(child.inputActive(), 0);
  renderer.drawFull();
  assert.deepEqual(row(), new Array(8).fill(0));
  call(0x31, [parentHandle, 0]);
  call(0x3f, [parentHandle, childHandle]);
  assert.equal(child.parent, null);
  assert.deepEqual(Array.from(parent.children()), []);
  call(0x33, [parentHandle, 2 << 16, 1 << 16, 0]);
  assert.deepEqual(point(parentHandle), [2, 1]);
  assert.deepEqual(point(childHandle), [4, 1]);
});

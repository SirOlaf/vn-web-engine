import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpThread, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {createGroup90PerspectivePoint} from '../dist/engines/buriko/games/aokana/native/group-90-perspective-point.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaBitmapStorage} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {AokanaDisplayManager} from '../dist/engines/buriko/games/aokana/native/display-manager.js';
import {AokanaDisplayObjectEnvironment} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
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

test('perspective point coordinates move a real Sprite through shared display geometry', () => {
  const {manager, surfaces} = fixture();
  assert.equal(surfaces.allocate(0, 2, 2, 1), 1);
  surfaces.fill(0, 0x204060);
  const handle = manager.createSprite();
  assert.equal(manager.initializeSimpleSprite(handle, 0, 0, 0, 0, 0, 1), 0);
  const memory = new AokanaBpMemory(new Uint8Array(64));
  const view = new DataView(memory.globalMemory.buffer);
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 8,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const [slot] = createGroup90PerspectivePoint();
  assert.deepEqual(
    [slot.primary, slot.secondary, slot.nativeAddress],
    [0x90, 0xcf, AOKANA_NATIVE_SLOT_ADDRESSES[0x90][0xcf]],
  );
  for (const [point, scales, expected] of [
    [
      [8, 6, 65536],
      [1, 3],
      [4, 4],
    ],
    [
      [2, 2, -65536],
      [1, 2],
      [4, 3],
    ],
  ]) {
    point.forEach((value, index) => view.setInt32(16 + index * 4, value, true));
    [32, 16, ...scales].forEach((value) => push32(thread, value));
    assert.equal(slot.execute({thread, memory}), 0);
    assert.equal(thread.stackIndex, 0);
    const x = view.getInt32(32, true),
      y = view.getInt32(36, true);
    assert.deepEqual([x, y], expected);
    assert.equal(manager.move(handle, x, y), true);
    assert.deepEqual(manager.resolve(handle).inputRectangle(0), {
      left: expected[0],
      top: expected[1],
      right: expected[0] + 1,
      bottom: expected[1] + 1,
    });
  }
});

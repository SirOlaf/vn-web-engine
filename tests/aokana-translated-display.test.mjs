import {bitmapWrite32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {createGroup91TranslatedDisplay} from '../dist/engines/buriko/games/aokana/native/group-91-translated-display.js';
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
  const bounds = rectangle(0, 0, 3, 1),
    output = bitmap(4, 2),
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

test('translated display wrappers render live Sprite pixels and consume the shared global origin', () => {
  const {allocator, manager, surfaces} = fixture();
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread, memory: new AokanaBpMemory(new Uint8Array(0)), diagnostics: {}};
  const slots = createGroup91TranslatedDisplay(manager);
  assert.deepEqual(
    slots.map((slot) => slot.secondary),
    [5, 6],
  );
  for (const slot of slots)
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x91][slot.secondary]);
  const call = (secondary, args, pushed = 0) => {
    args.forEach((value) => push32(thread, value));
    assert.equal(slots.find((slot) => slot.secondary === secondary).execute(context), 0);
    assert.equal(thread.stackIndex, pushed);
    return pushed ? pop32(thread) : undefined;
  };
  assert.equal(surfaces.allocate(0, 2, 2, 1), 1);
  const colors = [0x204060, 0x6080a0, 0x80a0c0, 0xc0e0f0];
  colors.forEach((color, index) => bitmapWrite32(surfaces.snapshot(0), index * 4, color));
  assert.equal(surfaces.allocate(1, 4, 2, 1), 1);
  const destination = surfaces.snapshot(1);
  for (let index = 0; index < 8; index++) bitmapWrite32(destination, index * 4, 0xffffff);
  const sprite = manager.find('sprite', manager.createSprite());
  assert.equal(sprite.initializeSimple(0, 0, 0, 0, 0, 3), 0);
  sprite.setActivation(1);
  new AokanaDisplayRenderer(manager, 1024, new AokanaDistributedProcessing(allocator, 2));
  const pixels = () =>
    Array.from({length: 8}, (_, index) => destination.storage.view.getUint32(index * 4, true));
  // Script+x negates the logical viewport origin, moving the rendered Sprite right.
  assert.equal(call(5, [1, 1, 0, 3], 1), 0);
  assert.deepEqual(pixels(), [0, colors[0], colors[1], 0, 0, colors[2], colors[3], 0]);
  call(6, [1, 0]);
  assert.equal(call(5, [1, 1, 0, 3], 1), 0);
  assert.deepEqual(pixels(), [0, 0, colors[0], colors[1], 0, 0, colors[2], colors[3]]);
  assert.equal(call(5, [1, 1, 0, 2], 1), 0);
  assert.deepEqual(pixels(), new Array(8).fill(0));
  assert.equal(thread.stackIndex, 0);
});

import {createGroup91SpriteMask} from '../dist/engines/buriko/games/aokana/native/group-91-sprite-mask.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, push32, pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
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
  const bounds = rectangle(0, 0, 7, 1),
    output = bitmap(8, 2),
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

test('dynamic Sprite mask renders contained and moved alignment then ordinary detach', () => {
  const {allocator, manager, surfaces, output} = fixture();
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 8,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread, memory: new AokanaBpMemory(new Uint8Array(8)), diagnostics: {}};
  const [slot] = createGroup91SpriteMask(manager);
  assert.equal(slot.primary, 0x91);
  assert.equal(slot.secondary, 0x55);
  assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x91][0x55]);
  assert.equal(surfaces.allocate(0, 8, 2, 1), 1);
  assert.equal(surfaces.allocate(1, 8, 2, 2), 1);
  surfaces.fill(0, 0x808080);
  surfaces.fill(1, 0x80000000);
  const owner = manager.createSprite(),
    mask = manager.createSprite();
  for (const [handle, surface] of [
    [owner, 0],
    [mask, 1],
  ]) {
    assert.equal(manager.initializeSimpleSprite(handle, 0, 0, surface, 0, 0, 2), 0);
    manager.find('sprite', handle).setActivation(1);
  }
  const renderer = new AokanaDisplayRenderer(
    manager,
    1024,
    new AokanaDistributedProcessing(allocator, 2),
  );
  manager.setBackdropActivation(1, 1);
  const call = (maskHandle) => {
    push32(thread, owner);
    push32(thread, maskHandle);
    assert.equal(slot.execute(context), 0);
    assert.equal(pop32(thread), 0);
    assert.equal(thread.stackIndex, 0);
  };
  const rows = () =>
    Array.from({length: 2}, (_, y) =>
      Array.from(
        {length: 8},
        (_, x) => output.storage.view.getUint32(y * output.stride + x * 4, true) & 0xffffff,
      ),
    );
  call(mask);
  renderer.drawFull();
  // (255 * 128 * 256) >>> 16 = 127; RGB blend coefficient 63 gives gray63.
  assert.deepEqual(rows(), [Array(8).fill(0x3f3f3f), Array(8).fill(0x3f3f3f)]);
  manager.find('sprite', mask).move(2, 0);
  renderer.drawFull();
  const shifted = [0, 0, ...Array(6).fill(0x3f3f3f)];
  assert.deepEqual(rows(), [shifted, shifted]);
  manager.find('sprite', mask).setActivation(0);
  call(0);
  renderer.drawFull();
  assert.deepEqual(rows(), [Array(8).fill(0x808080), Array(8).fill(0x808080)]);
});

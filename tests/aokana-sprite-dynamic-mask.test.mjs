import {createGroup91SpriteMask} from '../dist/engines/buriko/native/group-91-sprite-mask.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, push32, pop32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoBitmapStorage} from '../dist/engines/buriko/native/bitmap.js';
import {BurikoDisplayDamage} from '../dist/engines/buriko/native/display-damage.js';
import {BurikoDisplayManager} from '../dist/engines/buriko/native/display-manager.js';
import {BurikoDisplayObjectEnvironment} from '../dist/engines/buriko/native/display-object.js';
import {BurikoDisplayRenderer} from '../dist/engines/buriko/native/display-renderer.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';

const rectangle = (left, top, right, bottom) => ({left, top, right, bottom});
const bitmap = (width, height, values = []) => ({
  storage: new BurikoBitmapStorage(
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
  const compositor = new BurikoBitmapCompositor();
  compositor.defaultFormat = 1;
  const bounds = rectangle(0, 0, 7, 1),
    output = bitmap(8, 2),
    environment = new BurikoDisplayObjectEnvironment(
      compositor,
      new BurikoDisplayDamage(16, {...bounds}),
    );
  environment.displayContext = {bitmap: output, bounds};
  const allocator = new BurikoDistributedAllocator(2),
    text = new BurikoNativeText(),
    surfaces = new BurikoSurfaces(new BurikoNativeFonts(text), compositor, allocator),
    manager = new BurikoDisplayManager(
      environment,
      surfaces,
      new BurikoNativeDisplayState(1920, 1080),
    );
  return {allocator, compositor, environment, manager, output, surfaces, text};
}

test('dynamic Sprite mask renders contained and moved alignment then ordinary detach', () => {
  const {allocator, manager, surfaces, output} = fixture();
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 8,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread, memory: new BurikoBpMemory(new Uint8Array(8)), diagnostics: {}};
  const [slot] = createGroup91SpriteMask(manager);
  assert.equal(slot.primary, 0x91);
  assert.equal(slot.secondary, 0x55);
  assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x91][0x55]);
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
  const renderer = new BurikoDisplayRenderer(
    manager,
    1024,
    new BurikoDistributedProcessing(allocator, 2),
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

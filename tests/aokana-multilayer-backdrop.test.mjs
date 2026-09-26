import {bitmapWrite32} from '../dist/engines/buriko/native/bitmap-scalar.js';
import {createGroup91BackdropLayers} from '../dist/engines/buriko/native/group-91-backdrop-layers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, push32} from '../dist/engines/buriko/bp/state.js';
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
  const bounds = rectangle(0, 0, 7, 3),
    output = bitmap(8, 4),
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

test('multilayer backdrop renders shared affine layers and selected-layer animation state', () => {
  const {allocator, manager, surfaces, output, text} = fixture();
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 32,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread, memory: new BurikoBpMemory(new Uint8Array(16)), diagnostics: {}};
  const slots = createGroup91BackdropLayers(manager, {
    files: {text},
    threadFatal() {
      assert.fail('ordinary multilayer operation must succeed');
    },
  });
  assert.deepEqual(
    slots.map((slot) => slot.secondary),
    [0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a],
  );
  for (const slot of slots)
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x91][slot.secondary]);
  const call = (secondary, args) => {
    args.forEach((value) => push32(thread, value));
    assert.equal(slots.find((slot) => slot.secondary === secondary).execute(context), 0);
    assert.equal(thread.stackIndex, 0);
  };
  for (const [surface, color] of [
    [0, 0x202020],
    [1, 0x606060],
  ]) {
    assert.equal(surfaces.allocate(surface, 8, 4, 1), 1);
    surfaces.fill(surface, color);
  }
  const renderer = new BurikoDisplayRenderer(
    manager,
    1024,
    new BurikoDistributedProcessing(allocator, 2),
  );
  manager.setBackdropActivation(1, 1);
  call(0x40, [0, 0, 0, 0, 0, 0, 65536, 65536, 0]);
  assert.equal(manager.backdrop.backdropType, 12);
  const row = () => Array.from({length: 8}, (_, x) => output.storage.view.getUint32(x * 4, true));
  renderer.drawFull();
  assert.deepEqual(row(), Array(8).fill(0x202020));
  call(0x46, [1, 1, 0, 0]);
  call(0x47, [1, 0, 65536, 65536, 0]);
  call(0x43, [1, 0, 0]);
  call(0x44, [1, 0x20]);
  call(0x45, [1, 128]);
  call(0x42, [1, 1]);
  call(0x41, [1]);
  assert.equal(manager.backdrop.getBlendValue(), 128);
  assert.deepEqual(manager.backdrop.position(), {x: 0, y: 0});
  renderer.drawFull();
  assert.deepEqual(row(), Array(8).fill(0x404040));
  // Mode two takes the actual transformed temporary followed by additive composition.
  call(0x44, [1, 2]);
  call(0x45, [1, 256]);
  call(0x43, [1, 65536, 0]);
  assert.deepEqual(manager.backdrop.position(), {x: 65536, y: 0});
  renderer.drawFull();
  assert.deepEqual(row(), [0x202020, ...Array(7).fill(0x808080)]);
  // Shared base+D8 progress drives pivot/scaling while selected addition level stays 256.
  call(0x48, [1, 0, 0]);
  call(0x49, [1, 2 * 65536, 0]);
  call(0x4a, [1, 0, 65536, 0]);
  manager.backdrop.setValueD8(1, 0x800000);
  assert.equal(manager.backdrop.getBlendValue(), 256);
  renderer.drawFull();
  assert.deepEqual(row(), Array(8).fill(0x808080));
  call(0x42, [1, 0]);
  renderer.drawFull();
  assert.deepEqual(row(), Array(8).fill(0x202020));
});

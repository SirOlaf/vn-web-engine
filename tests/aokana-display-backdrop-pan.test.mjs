import {BurikoPanBackdrop} from '../dist/engines/buriko/native/display-backdrop-pan.js';
import {createGroup90BackdropPan} from '../dist/engines/buriko/native/group-90-backdrop-pan.js';
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
  const bounds = rectangle(0, 0, 1, 1),
    output = bitmap(2, 2),
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

test('four-surface backdrop pans shared quadrants through the manager renderer', () => {
  const {allocator, environment, manager, output, surfaces, text} = fixture();
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread, memory: new BurikoBpMemory(new Uint8Array(0)), diagnostics: {}};
  const errors = {
    files: {text},
    threadFatal() {
      throw new Error('unexpected valid backdrop diagnostic');
    },
  };
  const slot = createGroup90BackdropPan(manager, errors)[0];
  assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x90][0x42]);
  const colors = [0x102030, 0x405060, 0x708090, 0xa0b0c0];
  colors.forEach((color, index) => {
    assert.equal(surfaces.allocate(index, 2, 2, 1), 1);
    assert.equal(surfaces.fill(index, color), 1);
  });
  manager.setBackdropActivation(1, 1);
  [0, 1, 2, 3, 1, 1].forEach((value) => push32(thread, value));
  assert.equal(slot.execute(context), 0);
  assert.equal(thread.stackIndex, 0);
  const selected = manager.backdrop;
  assert.ok(selected instanceof BurikoPanBackdrop);
  assert.equal(manager.backdropRenderType, 3);
  assert.deepEqual(
    manager.lists.snapshot(false).map((entry) => entry.object),
    [selected],
  );
  const renderer = new BurikoDisplayRenderer(
    manager,
    3,
    new BurikoDistributedProcessing(allocator, 2),
  );
  const pixels = () =>
    Array.from({length: 4}, (_, i) => output.storage.view.getUint32(i * 4, true));
  renderer.drawFull();
  assert.deepEqual(pixels(), colors);
  // The native move virtual changes sampling coordinates, including the valid far edge.
  selected.move(2, 0);
  renderer.drawFull();
  assert.deepEqual(pixels(), new Array(4).fill(colors[1]));
  // Rebuilding rectangles is required even when geometry itself did not change.
  assert.equal(selected.resizeToDisplay(), 0);
  [0, 1, 2, 3, 0, 2].forEach((value) => push32(thread, value));
  assert.equal(slot.execute(context), 0);
  assert.equal(manager.backdrop, selected);
  assert.equal(thread.stackIndex, 0);
  renderer.drawFull();
  assert.deepEqual(pixels(), new Array(4).fill(colors[2]));
});

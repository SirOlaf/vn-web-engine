import {BurikoDifferenceBackdrop} from '../dist/engines/buriko/native/display-backdrop-difference.js';
import {createGroup90BackdropDifference} from '../dist/engines/buriko/native/group-90-backdrop-difference.js';
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
  const bounds = rectangle(0, 0, 31, 23),
    output = bitmap(32, 24),
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

test('difference backdrop uses actual frame notification, cached rectangles and damage rendering', () => {
  const {allocator, environment, manager, output, surfaces, text} = fixture();
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const globals = new Uint8Array(12),
    data = new DataView(globals.buffer);
  data.setUint32(4, 0, true);
  data.setUint32(8, 1, true);
  const context = {thread, memory: new BurikoBpMemory(globals), diagnostics: {}};
  const errors = {
    files: {text},
    threadFatal() {
      throw new Error('unexpected valid backdrop diagnostic');
    },
  };
  const slot = createGroup90BackdropDifference(manager, errors)[0];
  assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x90][0x44]);
  for (let index = 0; index < 2; index++) {
    assert.equal(surfaces.allocate(index, 32, 24, 1), 1);
    assert.equal(surfaces.fill(index, 0), 1);
  }
  const second = surfaces.snapshot(1);
  const inputPixel = (x, y, color) =>
    second.storage.view.setUint32(second.offset + y * second.stride + x * 4, color, true);
  inputPixel(2, 5, 0x112233);
  inputPixel(3, 5, 0x112233);
  inputPixel(7, 8, 0x445566);
  inputPixel(20, 10, 0x7f000000); // Native format1 difference detection ignores alpha.
  manager.setBackdropActivation(1, 1);
  [2, 4, 0].forEach((value) => push32(thread, value));
  assert.equal(slot.execute(context), 0);
  assert.equal(thread.stackIndex, 0);
  const selected = manager.backdrop;
  assert.ok(selected instanceof BurikoDifferenceBackdrop);
  assert.equal(manager.backdropRenderType, 5);
  const renderer = new BurikoDisplayRenderer(
    manager,
    1024,
    new BurikoDistributedProcessing(allocator, 2),
  );
  const pixel = (x, y) => output.storage.view.getUint32((y * 32 + x) * 4, true);
  renderer.drawFull(); // Real finishDraw stores selection0 through native virtualD0.
  assert.equal(pixel(2, 5), 0);
  selected.setBlendValue(1);
  selected.invalidate();
  const expected = [rectangle(2, 5, 3, 5), rectangle(7, 8, 7, 8)];
  const sorted = (rectangles) => rectangles.toSorted((a, b) => a.top - b.top || a.left - b.left);
  assert.equal(environment.damage.fullRedraw, 0);
  assert.deepEqual(sorted(environment.damage.snapshot().map((entry) => entry.rectangle)), expected);
  const damaged = renderer.drawDamage();
  assert.equal(damaged.count, 2);
  assert.deepEqual(sorted(damaged.rectangles), expected);
  assert.deepEqual(
    [pixel(2, 5), pixel(3, 5), pixel(7, 8), pixel(20, 10)],
    [0x112233, 0x112233, 0x445566, 0],
  );
  // finishDraw now remembers1; returning to0 uses the reverse ordered pair table.
  selected.setBlendValue(0);
  selected.invalidate();
  assert.deepEqual(sorted(environment.damage.snapshot().map((entry) => entry.rectangle)), expected);
  renderer.drawDamage();
  assert.deepEqual([pixel(2, 5), pixel(3, 5), pixel(7, 8)], [0, 0, 0]);
  // Whole-frame copy still copies alpha; only the difference detector ignores it.
  selected.setBlendValue(1);
  renderer.drawFull();
  assert.equal(pixel(20, 10), 0x7f000000);
  assert.equal(selected.resizeToDisplay(), 0);
  [2, 4, 0].forEach((value) => push32(thread, value));
  assert.equal(slot.execute(context), 0);
  assert.equal(manager.backdrop, selected);
  renderer.drawFull();
  assert.equal(pixel(20, 10), 0);
});

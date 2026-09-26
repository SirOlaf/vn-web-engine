import {bitmapWrite32} from '../dist/engines/buriko/native/bitmap-scalar.js';
import {BurikoRotationBackdrop} from '../dist/engines/buriko/native/display-backdrop-rotation.js';
import {createGroup90BackdropRotation} from '../dist/engines/buriko/native/group-90-backdrop-rotation.js';
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

test('rotation backdrop applies base, angle and scale delta through real affine rendering', () => {
  const {allocator, manager, output, surfaces, text} = fixture();
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
  const slot = createGroup90BackdropRotation(manager, errors)[0];
  assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x90][0x49]);
  assert.equal(surfaces.allocate(0, 6, 6, 1), 1);
  const source = surfaces.snapshot(0),
    colors = [0x102030, 0x204060, 0x406080, 0x6080a0, 0x80a0c0, 0xa0c0e0];
  for (let y = 0; y < 6; y++)
    for (let x = 0; x < 6; x++)
      bitmapWrite32(source, source.offset + y * source.stride + x * 4, colors[y]);
  manager.setBackdropActivation(1, 1);
  [0, 65536, 0].forEach((value) => push32(thread, value));
  assert.equal(slot.execute(context), 0);
  assert.equal(thread.stackIndex, 0);
  const selected = manager.backdrop;
  assert.ok(selected instanceof BurikoRotationBackdrop);
  assert.equal(manager.backdropRenderType, 10);
  const renderer = new BurikoDisplayRenderer(
    manager,
    1024,
    new BurikoDistributedProcessing(allocator, 2),
  );
  assert.equal(renderer.canUseStrips(), 0);
  const pixels = () =>
    Array.from({length: 4}, (_, index) => output.storage.view.getUint32(index * 4, true));
  renderer.drawFull();
  assert.deepEqual(pixels(), [colors[2], colors[2], colors[3], colors[3]]);
  // Unit scale, half turn: the destination rows sample source rows4 then3.
  assert.equal(selected.setProperty(0x101, 65536, 180 << 16), 0);
  renderer.drawFull();
  assert.deepEqual(pixels(), [colors[4], colors[4], colors[3], colors[3]]);
  // Actual property80 drives the sine scale envelope to2x at blend256.
  assert.equal(selected.setProperty(0x101, 65536, 0), 0);
  assert.equal(selected.setProperty(0x80, 65536, 0), 0);
  selected.setBlendValue(256);
  renderer.drawFull();
  // Both rows land at2.5 or3; native nearest sampling rounds both to3.
  assert.deepEqual(pixels(), new Array(4).fill(colors[3]));
});

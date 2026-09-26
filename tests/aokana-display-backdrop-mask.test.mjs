import {BurikoMaskedBackdrop} from '../dist/engines/buriko/native/display-backdrop-mask.js';
import {createGroup90BackdropMask} from '../dist/engines/buriko/native/group-90-backdrop-mask.js';
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

test('masked backdrop renders real sources with each native transition kernel', () => {
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
  const slot = createGroup90BackdropMask(manager, errors)[0];
  assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x90][0x43]);
  assert.equal(surfaces.allocate(0, 2, 2, 1), 1);
  assert.equal(surfaces.fill(0, 0x808080), 1);
  assert.equal(surfaces.allocate(1, 2, 2, 1), 1);
  assert.equal(surfaces.fill(1, 0), 1);
  assert.equal(surfaces.allocate(2, 2, 2, 3), 1);
  assert.equal(surfaces.fill(2, 0), 1);
  const mask = surfaces.snapshot(2);
  [0, 64, 128, 255].forEach((value, index) => {
    mask.storage.bytes[mask.offset + Math.floor(index / 2) * mask.stride + (index % 2)] = value;
  });
  manager.setBackdropActivation(1, 1);
  const renderer = new BurikoDisplayRenderer(
    manager,
    3,
    new BurikoDistributedProcessing(allocator, 2),
  );
  const configure = (maskIndex, parameter, blend, second = 1) => {
    [0, 0, 0, 0, 0, second, maskIndex, parameter, blend].forEach((value) => push32(thread, value));
    assert.equal(slot.execute(context), 0);
    assert.equal(thread.stackIndex, 0);
  };
  const expectGray = (values) => {
    renderer.drawFull();
    assert.deepEqual(
      Array.from({length: 4}, (_, index) => output.storage.view.getUint32(index * 4, true)),
      values.map((value) => value * 0x010101),
    );
  };
  configure(-1, 0, 128);
  const selected = manager.backdrop;
  assert.ok(selected instanceof BurikoMaskedBackdrop);
  assert.equal(manager.backdropRenderType, 4);
  expectGray([64, 64, 64, 64]);
  configure(2, 1, 64);
  assert.equal(manager.backdrop, selected);
  // Linear coverage64/192/full/full applied to128 over black.
  expectGray([32, 96, 128, 128]);
  selected.setValueD8(0, 128);
  assert.equal(selected.setProperty(0x40000000, 1, 2), 0);
  expectGray([16, 48, 64, 64]);
  assert.equal(selected.setProperty(0x40000000, 0, 0), 0);
  configure(2, 8, 128);
  // Seventeen triangle bands: quarter/half and near-final-band coverage.
  expectGray([0, 32, 64, 119]);
  assert.equal(selected.setProperty(0x40000000, 1, 2), 0);
  expectGray([0, 16, 32, 59]);
  assert.equal(selected.setProperty(0x40000000, 0, 0), 0);
  configure(2, 1, 64, 0x7001);
  expectGray([223, 159, 128, 128]);
  // Sentinel sources keep the destination outside first-source coverage; offset is real virtual state.
  configure(-1, 0, 0, 0x7fff);
  selected.move(0, 0);
  assert.deepEqual(selected.position(), {x: 0, y: 0});
  expectGray([128, 128, 128, 128]);
});

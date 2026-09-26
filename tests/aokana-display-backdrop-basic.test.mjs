import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoBitmapStorage} from '../dist/engines/buriko/native/bitmap.js';
import {BurikoNormalBackdrop} from '../dist/engines/buriko/native/display-backdrop.js';
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
import {createGroup90BackdropBasic} from '../dist/engines/buriko/native/group-90-backdrop-basic.js';
import {createGroup90DisplayDefault} from '../dist/engines/buriko/native/group-90-display-default.js';
import {BurikoBlendBackdrop} from '../dist/engines/buriko/native/display-backdrop-blend.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';

const rectangle = (left, top, right, bottom) => ({left, top, right, bottom});
const gray = (value) => Math.imul(value, 0x01010101) >>> 0;
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
  const bounds = rectangle(0, 0, 2, 1),
    output = bitmap(3, 2),
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

test('normal and blended backdrop wrappers preserve concrete lifecycle and render shared surfaces', () => {
  const {allocator, environment, manager, output, surfaces, text} = fixture(),
    thread = new BurikoBpThread({id: 1, operandCapacity: 32, moduleCapacity: 0, frameCapacity: 0}),
    context = {thread, memory: new BurikoBpMemory(new Uint8Array(0)), diagnostics: {}},
    errors = {
      files: {text},
      threadFatal(_thread, _diagnostics, message) {
        throw new Error(text.decodeCp932(message).replace(/\0.*$/, ''));
      },
    },
    slots = [
      ...createGroup90BackdropBasic(manager, errors),
      ...createGroup90DisplayDefault(manager, errors),
    ],
    renderer = new BurikoDisplayRenderer(manager, 3, new BurikoDistributedProcessing(allocator, 2));
  for (const [slot, color] of [
    [0, 0x204060],
    [1, 0x6080a0],
  ]) {
    assert.equal(surfaces.allocate(slot, 3, 2, 1), 1);
    assert.equal(surfaces.fill(slot, color), 1);
  }
  manager.setBackdropActivation(7, 9);
  const call = (secondary, ...args) => {
    args.forEach((value) => push32(thread, value));
    const result = slots.find((slot) => slot.secondary === secondary).execute(context);
    assert.equal(result, 0);
    assert.equal(thread.stackIndex, 0);
  };
  const pixels = () =>
    Array.from({length: 6}, (_, index) => output.storage.view.getUint32(index * 4, true));
  for (const slot of slots)
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x90][slot.secondary]);
  call(0x40, 0);
  const normal = manager.backdrop;
  assert.ok(normal instanceof BurikoNormalBackdrop);
  renderer.drawFull();
  assert.deepEqual(pixels(), new Array(6).fill(0x204060));
  environment.damage.clear();
  call(0x41, 0, 1, 128);
  const blended = manager.backdrop;
  assert.ok(blended instanceof BurikoBlendBackdrop);
  assert.notEqual(blended, normal);
  assert.deepEqual(
    [blended.activation, blended.contentEnabled, manager.backdropRenderType],
    [7, 9, 2],
  );
  assert.equal(environment.damage.fullRedraw, 1);
  assert.deepEqual(
    manager.lists.snapshot(false).map((entry) => entry.object),
    [blended],
  );
  renderer.drawFull();
  assert.deepEqual(pixels(), new Array(6).fill(0x406080));
  call(0x41, 0, 0x7000, 128);
  assert.equal(manager.backdrop, blended);
  renderer.drawFull();
  assert.deepEqual(pixels(), new Array(6).fill(0x102030));
  call(0x41, 0, 0x7001, 128);
  assert.equal(manager.backdrop, blended);
  renderer.drawFull();
  assert.deepEqual(pixels(), new Array(6).fill(0x8f9faf));
  call(0x40, 1);
  assert.ok(manager.backdrop instanceof BurikoNormalBackdrop);
  assert.deepEqual(
    [manager.backdrop.activation, manager.backdrop.contentEnabled, manager.backdropRenderType],
    [7, 9, 1],
  );
  renderer.drawFull();
  assert.deepEqual(pixels(), new Array(6).fill(0x6080a0));
  // Native virtualD8 reports unsupported image caching for this real object family.
  push32(thread, 0);
  assert.throws(
    () => slots.find((slot) => slot.secondary === 0x3f).execute(context),
    /指定されたディスプレイオブジェクトはイメージキャッシュをサポートしていません/,
  );
  assert.equal(thread.stackIndex, 0);
});

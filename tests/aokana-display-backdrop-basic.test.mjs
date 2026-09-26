import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaBitmapStorage} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {AokanaNormalBackdrop} from '../dist/engines/buriko/games/aokana/native/display-backdrop.js';
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
import {createGroup90BackdropBasic} from '../dist/engines/buriko/games/aokana/native/group-90-backdrop-basic.js';
import {createGroup90DisplayDefault} from '../dist/engines/buriko/games/aokana/native/group-90-display-default.js';
import {AokanaBlendBackdrop} from '../dist/engines/buriko/games/aokana/native/display-backdrop-blend.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';

const rectangle = (left, top, right, bottom) => ({left, top, right, bottom});
const gray = (value) => Math.imul(value, 0x01010101) >>> 0;
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
  const bounds = rectangle(0, 0, 2, 1),
    output = bitmap(3, 2),
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

test('normal and blended backdrop wrappers preserve concrete lifecycle and render shared surfaces', () => {
  const {allocator, environment, manager, output, surfaces, text} = fixture(),
    thread = new AokanaBpThread({id: 1, operandCapacity: 32, moduleCapacity: 0, frameCapacity: 0}),
    context = {thread, memory: new AokanaBpMemory(new Uint8Array(0)), diagnostics: {}},
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
    renderer = new AokanaDisplayRenderer(manager, 3, new AokanaDistributedProcessing(allocator, 2));
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
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x90][slot.secondary]);
  call(0x40, 0);
  const normal = manager.backdrop;
  assert.ok(normal instanceof AokanaNormalBackdrop);
  renderer.drawFull();
  assert.deepEqual(pixels(), new Array(6).fill(0x204060));
  environment.damage.clear();
  call(0x41, 0, 1, 128);
  const blended = manager.backdrop;
  assert.ok(blended instanceof AokanaBlendBackdrop);
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
  assert.ok(manager.backdrop instanceof AokanaNormalBackdrop);
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

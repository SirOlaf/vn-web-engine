import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {BurikoNativeInput} from '../dist/engines/buriko/native/input.js';
import {BurikoNativeTouch} from '../dist/engines/buriko/native/touch-input.js';
import {BurikoCursorPolicy} from '../dist/engines/buriko/native/cursor-policy.js';
import {BurikoNativeCursor} from '../dist/engines/buriko/native/engine-dialogs.js';
import {bitmapWrite32} from '../dist/engines/buriko/native/bitmap-scalar.js';
import {createGroup92ObjectPicker} from '../dist/engines/buriko/native/group-92-object-picker.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoBitmapStorage} from '../dist/engines/buriko/native/bitmap.js';
import {BurikoDisplayDamage} from '../dist/engines/buriko/native/display-damage.js';
import {BurikoDisplayManager} from '../dist/engines/buriko/native/display-manager.js';
import {BurikoDisplayObjectEnvironment} from '../dist/engines/buriko/native/display-object.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
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

test('pointer picker follows rendered order, real masks and shared cursor/touch capability', () => {
  const {manager, surfaces, output} = fixture();
  const display = manager.displayState;
  display.setSizePreset(2, 8, 4);
  display.requestedWidth = 16;
  display.requestedHeight = 8;
  const clock = new BurikoNativeClock(() => 0),
    input = new BurikoNativeInput(display, clock);
  input.foreground = input.pointerAvailable = true;
  const physical = new BurikoNativeCursor({style: {cursor: ''}});
  const cursor = new BurikoCursorPolicy(manager, input, clock, physical);
  const touchHost = {
    available: false,
    register: () => 1,
    unregister: () => 1,
    screenToClient: (x, y) => [x, y],
  };
  const touch = new BurikoNativeTouch(input, clock, touchHost);
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 8,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const memory = new BurikoBpMemory(new Uint8Array(8)),
    context = {thread, memory, diagnostics: {}};
  const [slot] = createGroup92ObjectPicker(manager, input, cursor, touch);
  assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x92][0x3d]);
  assert.equal(surfaces.allocate(0, 2, 1, 1), 1);
  assert.equal(surfaces.allocate(1, 2, 1, 1), 1);
  surfaces.fill(0, 0x204060);
  surfaces.fill(1, 0x6080a0);
  assert.equal(surfaces.allocate(2, 2, 1, 3), 1);
  const mask = surfaces.snapshot(2);
  mask.storage.bytes.set([1, 0]);
  mask.storage.written(0, 2);
  const lower = manager.createSprite(),
    upper = manager.createSprite();
  for (const [handle, surface, layer] of [
    [lower, 0, 2],
    [upper, 1, 3],
  ]) {
    const sprite = manager.find('sprite', handle);
    assert.equal(manager.initializeSimpleSprite(handle, 1, 1, surface, 0, 0, layer), 0);
    sprite.setActivation(1);
  }
  manager.resolve(upper).setHitMask(mask);
  manager.setRenderPixelBudget(1024);
  const renderer = manager.initializeObjectRenderer();
  renderer.drawFull();
  assert.deepEqual(
    [1, 2].map((x) => output.storage.view.getUint32(output.stride + x * 4, true)),
    [0x6080a0, 0x6080a0],
  );
  const pick = (x) => {
    input.pointerClientX = x * 2;
    input.pointerClientY = 2;
    push32(thread, 4);
    assert.equal(slot.execute(context), 0);
    const category = pop32(thread);
    assert.equal(thread.stackIndex, 0);
    return category;
  };
  const picked = () => new DataView(memory.globalMemory.buffer).getUint32(4, true);
  assert.equal(pick(1), 2);
  assert.equal(picked(), upper);
  assert.equal(manager.resolve(picked()).getLayer(), 3);
  assert.equal(pick(2), 2);
  assert.equal(picked(), lower);
  assert.equal(manager.resolve(upper).setProperty(0xc5, 0, 0), 0);
  assert.equal(pick(1), 2);
  assert.equal(picked(), lower);
  cursor.setVisible(0);
  assert.equal(pick(1), 0xffffffff);
  touchHost.available = true;
  assert.equal(input.touchPositions.length, 0);
  assert.equal(pick(1), 2);
  assert.equal(picked(), lower);
});

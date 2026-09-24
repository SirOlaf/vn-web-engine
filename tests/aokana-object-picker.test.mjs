import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {AokanaNativeInput} from '../dist/engines/buriko/games/aokana/native/input.js';
import {AokanaNativeTouch} from '../dist/engines/buriko/games/aokana/native/touch-input.js';
import {AokanaCursorPolicy} from '../dist/engines/buriko/games/aokana/native/cursor-policy.js';
import {AokanaNativeCursor} from '../dist/engines/buriko/games/aokana/native/engine-dialogs.js';
import {bitmapWrite32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {createGroup92ObjectPicker} from '../dist/engines/buriko/games/aokana/native/group-92-object-picker.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
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
  const bounds = rectangle(0, 0, 7, 3),
    output = bitmap(8, 4),
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

test('pointer picker follows rendered order, real masks and shared cursor/touch capability', () => {
  const {allocator, manager, surfaces, output} = fixture();
  const display = manager.displayState;
  display.setSizePreset(2, 8, 4);
  display.requestedWidth = 16;
  display.requestedHeight = 8;
  const clock = new AokanaNativeClock(() => 0),
    input = new AokanaNativeInput(display, clock);
  input.foreground = input.pointerAvailable = true;
  const physical = new AokanaNativeCursor({style: {cursor: ''}});
  const cursor = new AokanaCursorPolicy(manager, input, clock, physical);
  const touchHost = {
    available: false,
    register: () => 1,
    unregister: () => 1,
    screenToClient: (x, y) => [x, y],
  };
  const touch = new AokanaNativeTouch(input, clock, touchHost);
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 8,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const memory = new AokanaBpMemory(new Uint8Array(8)),
    context = {thread, memory, diagnostics: {}};
  const [slot] = createGroup92ObjectPicker(manager, input, cursor, touch);
  assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x92][0x3d]);
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
  const renderer = new AokanaDisplayRenderer(
    manager,
    1024,
    new AokanaDistributedProcessing(allocator, 2),
  );
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

import {AokanaPanBackdrop} from '../dist/engines/buriko/games/aokana/native/display-backdrop-pan.js';
import {createGroup90BackdropPan} from '../dist/engines/buriko/games/aokana/native/group-90-backdrop-pan.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
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
  const bounds = rectangle(0, 0, 1, 1),
    output = bitmap(2, 2),
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

test('four-surface backdrop pans shared quadrants through the manager renderer', () => {
  const {allocator, environment, manager, output, surfaces, text} = fixture();
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread, memory: new AokanaBpMemory(new Uint8Array(0)), diagnostics: {}};
  const errors = {
    files: {text},
    threadFatal() {
      throw new Error('unexpected valid backdrop diagnostic');
    },
  };
  const slot = createGroup90BackdropPan(manager, errors)[0];
  assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x90][0x42]);
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
  assert.ok(selected instanceof AokanaPanBackdrop);
  assert.equal(manager.backdropRenderType, 3);
  assert.deepEqual(
    manager.lists.snapshot(false).map((entry) => entry.object),
    [selected],
  );
  const renderer = new AokanaDisplayRenderer(
    manager,
    3,
    new AokanaDistributedProcessing(allocator, 2),
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

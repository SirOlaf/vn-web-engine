import {bitmapWrite32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {AokanaStretchBackdrop} from '../dist/engines/buriko/games/aokana/native/display-backdrop-stretch.js';
import {createGroup90BackdropStretch} from '../dist/engines/buriko/games/aokana/native/group-90-backdrop-stretch.js';
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

test('stretch backdrop interpolates configured source windows through real affine rendering', () => {
  const {allocator, manager, output, surfaces, text} = fixture();
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
  const slot = createGroup90BackdropStretch(manager, errors)[0];
  assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x90][0x48]);
  assert.equal(surfaces.allocate(0, 6, 2, 1), 1);
  const source = surfaces.snapshot(0),
    colors = [0x204060, 0x6080a0, 0xa0c0e0];
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < 6; x++)
      bitmapWrite32(source, source.offset + y * source.stride + x * 4, colors[Math.floor(x / 2)]);
  manager.setBackdropActivation(1, 1);
  [0, 0, 0, 2, 2].forEach((value) => push32(thread, value));
  assert.equal(slot.execute(context), 0);
  assert.equal(thread.stackIndex, 0);
  const selected = manager.backdrop;
  assert.ok(selected instanceof AokanaStretchBackdrop);
  assert.equal(manager.backdropRenderType, 9);
  assert.deepEqual(selected.position(), {x: 0, y: 0});
  // Native endpoint fields are configured by real property102 before the first draw.
  assert.equal(selected.setProperty(0x102, 4, 2 | (2 << 16)), 0);
  const renderer = new AokanaDisplayRenderer(
    manager,
    1024,
    new AokanaDistributedProcessing(allocator, 2),
  );
  assert.equal(renderer.canUseStrips(), 0);
  for (const [blend, color] of [
    [0, colors[0]],
    [128, colors[1]],
    [256, colors[2]],
  ]) {
    selected.setBlendValue(blend);
    renderer.drawFull();
    assert.deepEqual(
      Array.from({length: 4}, (_, index) => output.storage.view.getUint32(index * 4, true)),
      new Array(4).fill(color),
    );
  }
});

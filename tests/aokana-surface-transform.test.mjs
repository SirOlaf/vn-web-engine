import {bitmapWrite32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {createGroup91SurfaceTransform} from '../dist/engines/buriko/games/aokana/native/group-91-surface-transform.js';
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

test('91:18/19 rotate and blend initialized surfaces consumed by a real Sprite', () => {
  const {allocator, compositor, manager, surfaces, output, text} = fixture();
  const thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    context = {thread, memory: new AokanaBpMemory(new Uint8Array(8)), diagnostics: {}},
    slots = createGroup91SurfaceTransform(surfaces, {
      files: {text},
      threadFatal() {
        assert.fail('ordinary surface transform');
      },
    });
  for (const slot of slots)
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x91][slot.secondary]);
  const call = (secondary, args) => {
    args.forEach((value) => push32(thread, value));
    assert.equal(slots.find((slot) => slot.secondary === secondary).execute(context), 0);
    assert.equal(thread.stackIndex, 0);
  };
  const gray = (value) => value * 0x010101;
  assert.equal(surfaces.allocate(0, 2, 3, 1), 1);
  for (const index of [1, 2]) assert.equal(surfaces.allocate(index, 3, 2, 1), 1);
  const source = surfaces.snapshot(0);
  for (let i = 0; i < 6; i++) bitmapWrite32(source, source.offset + i * 4, gray((i + 1) * 16));
  for (const index of [1, 2]) {
    const image = surfaces.snapshot(index);
    for (let i = 0; i < 6; i++)
      bitmapWrite32(image, image.offset + i * 4, gray(index === 2 ? 128 : 0));
  }
  const processing = new AokanaDistributedProcessing(allocator, 2);
  compositor.processing = processing;
  const pixels = (image) =>
    Array.from({length: image.height}, (_, y) =>
      Array.from({length: image.width}, (_, x) =>
        image.storage.view.getUint32(image.offset + y * image.stride + x * 4, true),
      ),
    ).flat();
  try {
    call(0x19, [1, 0, 0, 0, 65536, 0, 90 * 65536, 65536, 65536, 0, 0]);
    assert.deepEqual(pixels(surfaces.snapshot(1)), [32, 64, 96, 16, 48, 80].map(gray));
    call(0x18, [2, 0, 0, 1, 0, 0, 0, 65536, 65536, 128, 0]);
    const expected = [80, 96, 112, 72, 88, 104].map(gray);
    assert.deepEqual(pixels(surfaces.snapshot(2)), expected);
    const sprite = manager.createSprite();
    assert.equal(manager.initializeSimpleSprite(sprite, 0, 0, 2, 0, 0, 2), 0);
    manager.find('sprite', sprite).setActivation(1);
    manager.setBackdropActivation(1, 1);
    new AokanaDisplayRenderer(manager, 1024, processing).drawFull();
    assert.deepEqual(pixels(output), expected);
  } finally {
    processing.dispose();
  }
});

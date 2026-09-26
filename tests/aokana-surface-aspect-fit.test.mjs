import {bitmapWrite32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import test from 'node:test';
import assert from 'node:assert/strict';
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

function fixture(width, height) {
  const compositor = new AokanaBitmapCompositor();
  compositor.defaultFormat = 1;
  const bounds = rectangle(0, 0, width - 1, height - 1),
    output = bitmap(width, height),
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
  const processing = new AokanaDistributedProcessing(allocator, 2);
  const renderer = new AokanaDisplayRenderer(manager, width * height * 8, processing);
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 32,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const slots = createGroup90AspectFit(surfaces, {
    threadFatal() {
      assert.fail('ordinary surface effect');
    },
  });
  const call = (secondary, args) => {
    const slot = slots.find((entry) => entry.secondary === secondary);
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x90][secondary]);
    args.forEach((value) => push32(thread, value));
    const previousProcessing = compositor.processing;
    compositor.processing = processing;
    try {
      assert.equal(slot.execute({thread, diagnostics: {}}), 0);
    } finally {
      compositor.processing = previousProcessing;
    }
    assert.equal(thread.stackIndex, 0);
  };
  function surface(index, format, value) {
    assert.equal(surfaces.allocate(index, width, height, format), 1);
    const image = surfaces.snapshot(index);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const offset = image.offset + y * image.stride + x * image.bytesPerPixel;
        if (format === 3) {
          image.storage.bytes[offset] = value(x, y);
          image.storage.written(offset, 1);
        } else bitmapWrite32(image, offset, value(x, y));
      }
    return image;
  }
  function render(index, expected) {
    const handle = manager.createSprite();
    assert.equal(manager.initializeSimpleSprite(handle, 0, 0, index, 0, 0, 2), 0);
    manager.find('sprite', handle).setActivation(1);
    manager.setBackdropActivation(1, 1);
    renderer.drawFull();
    assert.deepEqual(
      Array.from(
        {length: width * height},
        (_, i) =>
          output.storage.view.getUint32(
            Math.floor(i / width) * output.stride + (i % width) * 4,
            true,
          ) & 0xffffff,
      ),
      Array.from({length: width * height}, (_, i) => expected(i % width, Math.floor(i / width))),
    );
    manager.find('sprite', handle).setActivation(0);
  }
  return {surface, call, render, surfaces};
}

import {createGroup90AspectFit} from '../dist/engines/buriko/games/aokana/native/group-90-aspect-fit.js';
const gray = (value) => value * 0x010101;

// At half-source coordinates the cubic weights are [-1, 5, 5, -1]/8.
// Missing boundary samples are omitted before normalization: x1 is 112/1.125,
// x77 is 104/1.125, and x79 is 72/0.5. Nearest-even packing gives 100,92,144.
test('aspect fit cubic stretching crosses real worker strips and reaches sprites with both bar orientations', () => {
  const horizontal = fixture(80, 60);
  assert.equal(horizontal.surfaces.allocate(1, 40, 20, 1), 1);
  const striped = horizontal.surfaces.snapshot(1);
  for (let y = 0; y < 20; y++)
    for (let x = 0; x < 40; x++)
      bitmapWrite32(
        striped,
        striped.offset + y * striped.stride + x * 4,
        gray(x % 2 === 0 ? 64 : 128),
      );
  horizontal.surface(2, 1, () => gray(16));
  // Cropped area 80*40=3200 exceeds the actual two-worker dispatch threshold.
  horizontal.call(0xca, [2, 1]);
  horizontal.render(2, (x, y) => {
    if (y < 10 || y >= 50) return 0;
    if (x === 1) return gray(100);
    if (x === 77) return gray(92);
    if (x === 79) return gray(144);
    return gray(x % 2 === 1 ? 96 : x % 4 === 0 ? 64 : 128);
  });

  const vertical = fixture(60, 80);
  assert.equal(vertical.surfaces.allocate(1, 20, 40, 1), 1);
  const uniform = vertical.surfaces.snapshot(1);
  for (let y = 0; y < 40; y++)
    for (let x = 0; x < 20; x++)
      bitmapWrite32(uniform, uniform.offset + y * uniform.stride + x * 4, gray(90));
  vertical.surface(2, 1, () => gray(16));
  // The opposite aspect branch crops to 40*80=3200 and normalizes edge weights.
  vertical.call(0xca, [2, 1]);
  vertical.render(2, (x) => (x >= 10 && x < 50 ? gray(90) : 0));
});

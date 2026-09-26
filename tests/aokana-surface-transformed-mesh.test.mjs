import {bitmapWrite32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
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
  const slots = createGroup90TransformedMesh(surfaces, {
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

import {createGroup90TransformedMesh} from '../dist/engines/buriko/games/aokana/native/group-90-transformed-mesh.js';
const gray = (value) => value * 0x010101;

test('surface transformed mesh copies translated geometry and blends through actual sprites', () => {
  const s = fixture(5, 4);
  assert.equal(s.surfaces.allocate(1, 3, 2, 1), 1);
  const source = s.surfaces.snapshot(1);
  const colors = [32, 64, 96, 128, 160, 192];
  colors.forEach((value, index) =>
    bitmapWrite32(
      source,
      source.offset + Math.floor(index / 3) * source.stride + (index % 3) * 4,
      gray(value),
    ),
  );
  s.surface(2, 1, () => gray(16));
  s.surface(3, 1, () => gray(16));
  const args = (destination, mode, transparency) => [
    destination,
    65536,
    65536,
    1,
    0,
    0,
    65536,
    65536,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    mode,
    transparency,
  ];
  s.call(0xc8, args(2, 0, 0));
  s.render(2, (x, y) =>
    x >= 1 && x <= 3 && y >= 1 && y <= 2 ? gray(colors[(y - 1) * 3 + x - 1]) : 0,
  );
  s.call(0xc8, args(3, 1, 128));
  s.render(3, (x, y) =>
    x >= 1 && x <= 3 && y >= 1 && y <= 2 ? gray((colors[(y - 1) * 3 + x - 1] + 16) / 2) : gray(16),
  );
});

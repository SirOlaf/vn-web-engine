import {bitmapWrite32} from '../dist/engines/buriko/native/bitmap-scalar.js';
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

function fixture(width, height, compatibility = '1.72') {
  const compositor = new BurikoBitmapCompositor(compatibility);
  compositor.defaultFormat = 1;
  const bounds = rectangle(0, 0, width - 1, height - 1),
    output = bitmap(width, height),
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
  const processing = new BurikoDistributedProcessing(allocator, 2);
  const renderer = new BurikoDisplayRenderer(manager, width * height * 8, processing);
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const slots = createGroup90SurfaceEffects(new BurikoSurfaceEffects(surfaces), {
    threadFatal() {
      assert.fail('ordinary surface effect');
    },
  });
  const call = (secondary, args) => {
    const slot = slots.find((entry) => entry.secondary === secondary);
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x90][secondary]);
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
  function maskedBackdrop(first, second, mask, parameter, level, expected) {
    assert.equal(
      manager.configureMaskedBackdrop(0, 0, first, 0, 0, second, mask, parameter, level),
      0,
    );
    manager.setBackdropActivation(1, 1);
    renderer.drawFull();
    assert.deepEqual(
      Array.from(
        {length: width * height},
        (_, i) => output.storage.view.getUint32(i * 4, true) & 0xffffff,
      ),
      Array.from({length: width * height}, (_, i) => expected(i % width, Math.floor(i / width))),
    );
  }
  return {surface, call, render, maskedBackdrop};
}

import {BurikoSurfaceEffects} from '../dist/engines/buriko/native/surface-effects.js';
import {createGroup90SurfaceEffects} from '../dist/engines/buriko/native/group-90-surface-effects.js';
const gray = (value) => value * 0x010101;

test('masked transition and optional-mask mix feed real sprites', () => {
  const s = fixture(4, 2);
  s.surface(1, 1, () => gray(32));
  s.surface(2, 1, () => gray(160));
  s.surface(3, 3, (x) => [0, 64, 128, 255][x]);
  s.surface(4, 1, () => gray(32));
  s.call(0x19, [1, 0, 0, 2, 3, 0, 128]);
  // parameter0,level128 makes coverage equal to the grayscale byte.
  s.render(1, (x) => gray([32, 64, 96, 159][x]));
  s.call(0x19, [4, 1, 0, 2, -1, 0, 128]);
  s.render(4, (x) => gray(x === 0 ? 32 : 96));
});

test('1.69 surface and backdrop transitions select low-three-bit triangle frequency', () => {
  const s = fixture(7, 2, '1.69'),
    coverage = [20, 40, 80, 120, 160, 200, 240],
    expected = (x) => gray(32 + coverage[x] / 2);
  s.surface(1, 1, () => gray(32));
  s.surface(2, 1, () => gray(160));
  s.surface(3, 3, (x) => coverage[x]);
  s.surface(4, 1, () => gray(32));
  s.call(0x19, [4, 0, 0, 2, 3, 8, 128]);
  s.render(4, expected);
  // Different high selector bits are the same frequency in this native revision.
  s.maskedBackdrop(2, 1, 3, 24, 128, expected);
});

test('vector strips retain source bounds across rows and select actual endpoint maps', () => {
  const s = fixture(9, 300);
  s.surface(1, 1, (_x, y) => gray(y % 2 === 0 ? 64 : 128));
  s.surface(2, 4, () => 16 << 16);
  s.surface(3, 4, () => 32 << 16);
  s.surface(4, 4, () => 0);
  const cases = [
    [2, -1, 256, 1, 1],
    [3, -1, 128, 1, 1],
    [4, 3, 128, 1, 1],
    [2, 3, 0, 1, 1],
    [4, 2, 256, 1, 1],
    [2, -1, 256, 0, 1],
    [4, 3, 128, 0, 1],
  ];
  cases.forEach(([first, second, level, bilinear, shift], index) => {
    const destination = 10 + index;
    s.surface(destination, 1, () => 0);
    s.call(0x1a, [destination, 1, first, second, level, bilinear]);
    s.render(destination, (_x, y) =>
      y + shift >= 300 ? 0 : gray((y + shift) % 2 === 0 ? 64 : 128),
    );
  });
});

test('horizontal vertical and two-pass blur use actual processing and renderer owners', () => {
  const s = fixture(65, 41);
  s.surface(1, 1, (_x, y) => gray(y % 2 === 0 ? 64 : 128));
  s.surface(2, 1, (x) => gray(x % 2 === 0 ? 64 : 128));
  s.surface(3, 1, () => gray(90));
  for (const index of [4, 5, 6]) s.surface(index, 1, () => 0);
  s.call(0x1b, [4, 1, 1, 1]);
  s.render(4, (_x, y) => gray(y % 2 === 0 ? 64 : 128));
  s.call(0x1b, [5, 2, 3, 1]);
  s.render(5, (x) => gray(x % 2 === 0 ? 64 : 128));
  s.call(0x1b, [6, 3, 4, 1]);
  s.render(6, (x, y) =>
    gray(x === 0 || x === 64 ? (y === 0 || y === 40 ? 40 : 60) : y === 0 || y === 40 ? 60 : 90),
  );
});

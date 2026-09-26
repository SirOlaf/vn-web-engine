import {bitmapWrite32} from '../dist/engines/buriko/native/bitmap-scalar.js';
import {BurikoCrtRandom} from '../dist/engines/buriko/native/system-timing.js';
import {createGroup91DisplacementMaps} from '../dist/engines/buriko/native/group-91-displacement-maps.js';
import {createGroup90BackdropVector} from '../dist/engines/buriko/native/group-90-backdrop-vector.js';
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

function fixture() {
  const compositor = new BurikoBitmapCompositor();
  compositor.defaultFormat = 1;
  const bounds = rectangle(0, 0, 1, 1),
    output = bitmap(2, 2),
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

test('scaled and random displacement writers feed the real vector backdrop', () => {
  const {allocator, manager, output, surfaces, text} = fixture();
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread, memory: new BurikoBpMemory(new Uint8Array(0)), diagnostics: {}};
  const errors = {
    files: {text},
    threadFatal() {
      assert.fail('ordinary displacement operation');
    },
  };
  const random = new BurikoCrtRandom();
  const slots = createGroup91DisplacementMaps(surfaces, random, errors);
  const backdropSlots = createGroup90BackdropVector(manager, errors);
  assert.deepEqual(
    slots.map((slot) => [slot.primary, slot.secondary]),
    [
      [0x91, 0x10],
      [0x91, 0x11],
    ],
  );
  for (const slot of slots)
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x91][slot.secondary]);
  const call = (definitions, secondary, args) => {
    args.forEach((value) => push32(thread, value));
    assert.equal(definitions.find((slot) => slot.secondary === secondary).execute(context), 0);
    assert.equal(thread.stackIndex, 0);
  };
  assert.equal(surfaces.allocate(0, 2, 2, 1), 1);
  assert.equal(surfaces.allocate(1, 2, 2, 4), 1);
  const source = surfaces.snapshot(0),
    map = surfaces.snapshot(1);
  [0x102030, 0x405060, 0x708090, 0xa0b0c0].forEach((color, index) =>
    bitmapWrite32(
      source,
      source.offset + Math.floor(index / 2) * source.stride + (index % 2) * 4,
      color,
    ),
  );
  const words = () =>
    Array.from({length: 4}, (_, index) => {
      const at = map.offset + Math.floor(index / 2) * map.stride + (index % 2) * 4;
      return [map.storage.view.getInt16(at, true), map.storage.view.getInt16(at + 2, true)];
    });
  const renderer = new BurikoDisplayRenderer(
    manager,
    1024,
    new BurikoDistributedProcessing(allocator, 2),
  );
  const expectPixels = (expected) => {
    renderer.drawFull();
    assert.deepEqual(
      Array.from({length: 4}, (_, index) => output.storage.view.getUint32(index * 4, true)),
      expected,
    );
  };
  call(slots, 0x10, [1, 1, 0, 1, 1]);
  assert.deepEqual(words(), [
    [16, 0],
    [8, 0],
    [16, -8],
    [8, -8],
  ]);
  call(backdropSlots, 0x4c, [1, 1]);
  call(backdropSlots, 0x45, [0, 1, -1, 256, 0]);
  expectPixels([0x405060, 0x405060, 0x405060, 0x405060]);
  random.seed(1);
  call(slots, 0x11, [1, 1]);
  // First16 actual CRT draws paired modulo3, with each component stored as signed Q4.
  assert.deepEqual(words(), [
    [1, 1],
    [-1, 1],
    [0, 1],
    [-1, 0],
  ]);
  expectPixels([0x102030, 0x102030, 0x708090, 0x708090]);
});

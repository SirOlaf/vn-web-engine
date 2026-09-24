import {bitmapWrite32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {AokanaCrtRandom} from '../dist/engines/buriko/games/aokana/native/system-timing.js';
import {createGroup91DisplacementMaps} from '../dist/engines/buriko/games/aokana/native/group-91-displacement-maps.js';
import {createGroup90BackdropVector} from '../dist/engines/buriko/games/aokana/native/group-90-backdrop-vector.js';
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

test('scaled and random displacement writers feed the real vector backdrop', () => {
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
      assert.fail('ordinary displacement operation');
    },
  };
  const random = new AokanaCrtRandom();
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
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x91][slot.secondary]);
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
  const renderer = new AokanaDisplayRenderer(
    manager,
    1024,
    new AokanaDistributedProcessing(allocator, 2),
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

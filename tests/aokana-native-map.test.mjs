import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {allocateAokanaBitmap} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {AokanaDisplayManager} from '../dist/engines/buriko/games/aokana/native/display-manager.js';
import {AokanaDisplayMap} from '../dist/engines/buriko/games/aokana/native/display-map.js';
import {AokanaDisplayObjectEnvironment} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {createGroup90Maps} from '../dist/engines/buriko/games/aokana/native/group-90-maps.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
import {AokanaMapDisplays} from '../dist/engines/buriko/games/aokana/native/map-displays.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';

test('Map services share the display pool and scroll copied cells through the real compositor', () => {
  const compositor = new AokanaBitmapCompositor();
  compositor.defaultFormat = 1;
  const bounds = {left: 0, top: 0, right: 3, bottom: 0};
  const environment = new AokanaDisplayObjectEnvironment(
    compositor,
    new AokanaDisplayDamage(16, bounds),
  );
  const output = allocateAokanaBitmap(4, 1, 2);
  environment.displayContext = {bitmap: output, bounds};
  const surfaces = new AokanaSurfaces(
    new AokanaNativeFonts(new AokanaNativeText()),
    compositor,
    new AokanaDistributedAllocator(2),
  );
  const manager = new AokanaDisplayManager(
    environment,
    surfaces,
    new AokanaNativeDisplayState(1920, 1080),
  );
  const maps = new AokanaMapDisplays(manager);
  const definitions = createGroup90Maps(maps, {
    files: {text: {encodeWide: (message) => message}},
    threadFatal() {
      assert.fail('ordinary Map operations should succeed');
    },
  });
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 32,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const bytes = new Uint8Array(32),
    data = new DataView(bytes.buffer);
  [0, 1, 2, 2, 1, 0].forEach((cell, index) => data.setUint16(4 + index * 2, cell, true));
  const context = {thread, memory: new AokanaBpMemory(bytes), diagnostics: {}};
  const call = (secondary, args = [], pushed = 0) => {
    const depth = thread.stackIndex;
    args.forEach((value) => push32(thread, value));
    assert.equal(definitions.find((slot) => slot.secondary === secondary).execute(context), 0);
    assert.equal(thread.stackIndex, depth + pushed);
  };
  assert.deepEqual(
    definitions.map((slot) => slot.secondary),
    [0x70, 0x71, 0x74, 0x75, 0x76, 0x78, 0x79, 0x7a],
  );
  for (const slot of definitions)
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x90][slot.secondary]);
  assert.equal(surfaces.allocate(3, 6, 1, 2), 1);
  const tiles = surfaces.descriptor(3);
  const pixels = [0xff000011, 0xff000012, 0xff000021, 0xff000022, 0xff000031, 0xff000032];
  pixels.forEach((pixel, index) => tiles.storage.view.setUint32(index * 4, pixel, true));
  tiles.storage.written(0, 24);
  call(0x70, [], 1);
  const handle = pop32(thread),
    map = manager.find('map', handle);
  assert.equal(handle, 0xa0000000);
  assert.ok(map instanceof AokanaDisplayMap);
  assert.equal(map.surfaces, manager.surfaces);
  assert.equal(manager.categoryCount(3), 1);
  call(0x76, [handle, 2, 1, 2, 1]);
  call(0x75, [handle, 0, 0, 3, 0x80, 0, 2]);
  call(0x78, [handle, 3, 2, 4]);
  data.setUint16(4, 2, true); // The installed map owns a copy of the supplied cells.
  call(0x74, [handle, 1]);
  const draw = () => {
    map.draw(output, bounds, 0);
    return Array.from({length: 4}, (_, i) => output.storage.view.getUint32(i * 4, true));
  };
  call(0x79, [handle, 0, 0, 1, 0, 1]);
  assert.deepEqual(draw(), [pixels[1], pixels[2], pixels[3], pixels[4]]);
  call(0x79, [handle, 2, 0, 1, 0, 1]);
  assert.deepEqual(draw(), [pixels[5], pixels[0], pixels[1], pixels[2]]);
  call(0x79, [handle, 1, 0, 0, 0, 0]);
  assert.deepEqual(draw(), [pixels[2], pixels[3], pixels[4], pixels[5]]);
  call(0x79, [handle, 2, 0, 0, 0, 0]);
  assert.deepEqual(draw(), [pixels[4], pixels[5], 0, 0]);
  call(0x7a, [handle, 7]); // Ordinary invalidation of an unused tile, without pointer-edge probing.
  // Resize the same display to ordinary strip-dispatch dimensions using its shared worker owner.
  const processing = new AokanaDistributedProcessing(surfaces.allocator, 2);
  compositor.processing = processing;
  let runs = 0;
  const run = processing.run.bind(processing);
  processing.run = (...args) => {
    runs++;
    return run(...args);
  };
  call(0x76, [handle, 2, 2, 32, 32]);
  assert.equal(surfaces.allocate(4, 64, 32, 2), 1);
  const largeTiles = surfaces.descriptor(4);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 64; x++)
      largeTiles.storage.view.setUint32((y * 64 + x) * 4, x < 32 ? pixels[0] : pixels[2], true);
  largeTiles.storage.written(0, largeTiles.storage.bytes.length);
  call(0x75, [handle, 0, 0, 4, 0x80, 0, 2]);
  call(0x79, [handle, 0, 0, 0, 0, 1]);
  const largeOutput = allocateAokanaBitmap(64, 64, 2);
  map.draw(largeOutput, {left: 0, top: 0, right: 63, bottom: 63}, 0);
  assert.equal(runs, 1);
  assert.equal(compositor.processing, processing);
  assert.deepEqual(
    [0, 32, 32 * 64, 32 * 64 + 32].map((i) => largeOutput.storage.view.getUint32(i * 4, true)),
    [pixels[0], pixels[2], 0, pixels[2]],
  );
  call(0x71, [handle]);
  assert.equal(manager.categoryCount(3), 0);
  assert.equal(thread.stackIndex, 0);
});

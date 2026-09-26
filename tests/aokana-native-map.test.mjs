import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {allocateBurikoBitmap} from '../dist/engines/buriko/native/bitmap.js';
import {BurikoDisplayDamage} from '../dist/engines/buriko/native/display-damage.js';
import {BurikoDisplayManager} from '../dist/engines/buriko/native/display-manager.js';
import {BurikoDisplayMap} from '../dist/engines/buriko/native/display-map.js';
import {BurikoDisplayObjectEnvironment} from '../dist/engines/buriko/native/display-object.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {createGroup90Maps} from '../dist/engines/buriko/native/group-90-maps.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';
import {BurikoMapDisplays} from '../dist/engines/buriko/native/map-displays.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';

test('Map services share the display pool and scroll copied cells through the real compositor', () => {
  const compositor = new BurikoBitmapCompositor();
  compositor.defaultFormat = 1;
  const bounds = {left: 0, top: 0, right: 3, bottom: 0};
  const environment = new BurikoDisplayObjectEnvironment(
    compositor,
    new BurikoDisplayDamage(16, bounds),
  );
  const output = allocateBurikoBitmap(4, 1, 2);
  environment.displayContext = {bitmap: output, bounds};
  const surfaces = new BurikoSurfaces(
    new BurikoNativeFonts(new BurikoNativeText()),
    compositor,
    new BurikoDistributedAllocator(2),
  );
  const manager = new BurikoDisplayManager(
    environment,
    surfaces,
    new BurikoNativeDisplayState(1920, 1080),
  );
  const maps = new BurikoMapDisplays(manager);
  const definitions = createGroup90Maps(maps, {
    files: {text: {encodeWide: (message) => message}},
    threadFatal() {
      assert.fail('ordinary Map operations should succeed');
    },
  });
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 32,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const bytes = new Uint8Array(32),
    data = new DataView(bytes.buffer);
  [0, 1, 2, 2, 1, 0].forEach((cell, index) => data.setUint16(4 + index * 2, cell, true));
  const context = {thread, memory: new BurikoBpMemory(bytes), diagnostics: {}};
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
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x90][slot.secondary]);
  assert.equal(surfaces.allocate(3, 6, 1, 2), 1);
  const tiles = surfaces.descriptor(3);
  const pixels = [0xff000011, 0xff000012, 0xff000021, 0xff000022, 0xff000031, 0xff000032];
  pixels.forEach((pixel, index) => tiles.storage.view.setUint32(index * 4, pixel, true));
  tiles.storage.written(0, 24);
  call(0x70, [], 1);
  const handle = pop32(thread),
    map = manager.find('map', handle);
  assert.equal(handle, 0xa0000000);
  assert.ok(map instanceof BurikoDisplayMap);
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
  const processing = new BurikoDistributedProcessing(surfaces.allocator, 2);
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
  const largeOutput = allocateBurikoBitmap(64, 64, 2);
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

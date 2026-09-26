import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {allocateAokanaBitmap} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {clearAokanaBitmap} from '../dist/engines/buriko/games/aokana/native/bitmap-copy.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {AokanaDisplayManager} from '../dist/engines/buriko/games/aokana/native/display-manager.js';
import {AokanaDisplayLandscape} from '../dist/engines/buriko/games/aokana/native/display-landscape.js';
import {AokanaDisplayObjectEnvironment} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {createGroup91Landscapes} from '../dist/engines/buriko/games/aokana/native/group-91-landscapes.js';
import {AokanaNativeInput} from '../dist/engines/buriko/games/aokana/native/input.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
import {AokanaLandscapeDisplays} from '../dist/engines/buriko/games/aokana/native/landscape-displays.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';

test('Landscape composes terrain, sorted cells, overlays and pointer queries through shared owners', () => {
  const compositor = new AokanaBitmapCompositor();
  compositor.defaultFormat = 2;
  const bounds = {left: 0, top: 0, right: 11, bottom: 9},
    output = allocateAokanaBitmap(12, 10, 2);
  const environment = new AokanaDisplayObjectEnvironment(
    compositor,
    new AokanaDisplayDamage(32, bounds),
  );
  environment.displayContext = {bitmap: output, bounds};
  const surfaces = new AokanaSurfaces(
    new AokanaNativeFonts(new AokanaNativeText()),
    compositor,
    new AokanaDistributedAllocator(1),
  );
  const display = new AokanaNativeDisplayState(12, 10),
    manager = new AokanaDisplayManager(environment, surfaces, display),
    input = new AokanaNativeInput(display, new AokanaNativeClock(() => 0));
  const landscapes = new AokanaLandscapeDisplays(manager, input);
  const slots = createGroup91Landscapes(landscapes, {
    files: {text: {encodeWide: (message) => message}},
    threadFatal() {
      assert.fail('ordinary Landscape operations should succeed');
    },
  });
  const bytes = new Uint8Array(1024),
    data = new DataView(bytes.buffer),
    thread = new AokanaBpThread({id: 1, operandCapacity: 32, moduleCapacity: 0, frameCapacity: 0});
  const context = {thread, memory: new AokanaBpMemory(bytes), diagnostics: {}};
  const put = (offset, values) =>
    values.forEach((value, i) => data.setUint32(offset + i * 4, value, true));
  const call = (secondary, args = [], pushed = 0) => {
    const depth = thread.stackIndex;
    args.forEach((value) => push32(thread, value));
    assert.equal(slots.find((slot) => slot.secondary === secondary).execute(context), 0);
    assert.equal(thread.stackIndex, depth + pushed);
  };
  assert.deepEqual(
    slots.map((slot) => slot.secondary),
    [0x70, 0x71, 0x73, 0x74, 0x75, 0x76, 0x78, 0x79, 0x7a, 0x7b, 0x7c, 0x7d, 0x7e, 0x7f],
  );
  for (const slot of slots)
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x91][slot.secondary]);
  assert.equal(surfaces.allocate(3, 8, 4, 2), 1);
  const atlas = surfaces.descriptor(3),
    red = 0xff0000e0,
    blue = 0xffd00000;
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 8; x++)
      atlas.storage.view.setUint32((y * 8 + x) * 4, x < 4 ? red : blue, true);
  atlas.storage.written(0, 128);
  put(4, [0, 0, 4, 4, 0, 4, 0, 4, 4, 0]);
  put(64, [1, 0]);
  data.setUint32(64 + 33 * 4, 1, true);
  put(200, [2, 0, 1]);
  data.setUint32(200 + 33 * 4, 1, true);
  put(400, [0, 1, 1, 0]);
  call(0x70, [4, 2, 2, 6, 1, 1], 1);
  const handle = pop32(thread),
    landscape = manager.find('landscape', handle);
  assert.equal(handle, 0xa1000000);
  assert.ok(landscape instanceof AokanaDisplayLandscape);
  assert.equal(landscape.surfaces, surfaces);
  assert.equal(landscape.environment, environment);
  assert.equal(manager.categoryCount(4), 1);
  call(0x75, [handle, 0, 0, 0x80, 0, 2]);
  call(0x78, [handle, 3, 2, 4, 1, 2, 64]);
  call(0x79, [handle, 2, 2, 400]);
  data.setUint32(400, 1, true); // Row records own their copied cell IDs.
  call(0x74, [handle, 1]);
  const keys = new Uint32Array(landscape.copyExpandedSortKeys(null));
  landscape.copyExpandedSortKeys(keys);
  assert.deepEqual([...keys], [0x22000, 0x32000, 0x32020, 0x42020]);
  const pixel = (x, y) => output.storage.view.getUint32((y * 12 + x) * 4, true);
  const draw = (key) => {
    clearAokanaBitmap(output);
    landscape.draw(output, bounds, key);
  };
  draw(0x22000);
  assert.equal(pixel(1, 3), red);
  assert.equal(pixel(5, 1), 0);
  draw(0x32000);
  assert.equal(pixel(5, 1), blue);
  assert.equal(pixel(5, 5), red);
  call(0x7e, [500, handle, 0, 1], 1);
  assert.equal(pop32(thread), 1);
  assert.equal(data.getUint32(500, true), 3);
  call(0x7f, [5, handle, 0, 1], 1);
  assert.equal(pop32(thread), 1);
  assert.equal(surfaces.descriptor(5).storage.view.getUint32(0, true), red);
  // Mode one checks the retained alpha snapshot at the recipe's designated top.
  input.pointerAvailable = true;
  input.touchPositions = [[5, 1]];
  call(0x73, [504, handle, 0], 1);
  assert.equal(pop32(thread), 1);
  assert.deepEqual([data.getUint32(504, true), data.getUint32(508, true)], [1, 0]);
  put(504, [77, 88]);
  call(0x73, [504, handle, 1], 1);
  assert.equal(pop32(thread), 0);
  assert.deepEqual([data.getUint32(504, true), data.getUint32(508, true)], [77, 88]);
  // Ordinary silhouette replacement through the real compositor.
  call(0x76, [handle, 0, 0, 1, 256, 0x00a0b0c0]);
  draw(0x22000);
  assert.equal(pixel(1, 3), 0xffa0b0c0);
  call(0x76, [handle, 0, 0, 0, 0, 0]);
  put(520, [0, 0, 2, 2, 0]);
  call(0x7a, [handle, 3, 1, 520]);
  put(544, [1, 0]);
  call(0x7b, [handle, 1, 544, 0, 0, 0]);
  draw(0x32000);
  assert.equal(pixel(5, 2), red);
  call(0x7b, [handle, 1, 544, 0, 0xffffffff, 0]);
  call(0x7c, [handle, 0, 1]);
  draw(0x22000);
  assert.equal(pixel(1, 3), blue);
  call(0x7d, [handle, 1, 1, 1]);
  call(0x7e, [500, handle, 1, 1], 1);
  assert.equal(pop32(thread), 1);
  assert.equal(data.getUint32(500, true), 4);
  call(0x71, [handle]);
  assert.equal(manager.categoryCount(4), 0);
  assert.equal(thread.stackIndex, 0);
});

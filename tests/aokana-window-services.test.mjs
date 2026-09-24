import {
  allocateAokanaBitmap,
  fillAokanaBitmap,
} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {AokanaWindowDisplayState} from '../dist/engines/buriko/games/aokana/native/display-window-state.js';
import {AokanaWindowDisplayObject} from '../dist/engines/buriko/games/aokana/native/display-window.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {AokanaDisplayManager} from '../dist/engines/buriko/games/aokana/native/display-manager.js';
import {AokanaDisplayObjectEnvironment} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {createGroup91WindowState} from '../dist/engines/buriko/games/aokana/native/group-91-window-state.js';
import {createGroup92WindowImages} from '../dist/engines/buriko/games/aokana/native/group-92-window-images.js';
import {bitmapWrite32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';

test('Window services share registered fonts, cursor state, composed pixels and published damage', async () => {
  const compositor = new AokanaBitmapCompositor();
  compositor.defaultFormat = 1;
  const text = new AokanaNativeText();
  const fonts = new AokanaNativeFonts(text, {
    async queryCharset() {
      return 1;
    },
    async create(parameters) {
      return {faceName: parameters.face, familyName: parameters.face, averageWidth: 8, ascent: 8};
    },
  });
  const surfaces = new AokanaSurfaces(fonts, compositor, new AokanaDistributedAllocator(1));
  const damage = new AokanaDisplayDamage(32, {left: 0, top: 0, right: 127, bottom: 63});
  const manager = new AokanaDisplayManager(
    new AokanaDisplayObjectEnvironment(compositor, damage),
    surfaces,
    new AokanaNativeDisplayState(128, 64),
  );
  const output = allocateAokanaBitmap(128, 64, 1);
  fillAokanaBitmap(output, 0);
  manager.bindDisplayContext({bitmap: output, bounds: {left: 0, top: 0, right: 127, bottom: 63}});
  const state = new AokanaWindowDisplayState(manager);
  const created = manager.createConfigured(
    'window',
    (order) => new AokanaWindowDisplayObject(state, order),
    (object) => object.configureInitial(2, 1),
  );
  assert.equal(created.result, 0);
  const handle = created.handle,
    window = manager.find('window', handle);
  window.setTextRectangle({left: 0, top: 0, right: 3, bottom: 1});
  window.configureDisplay(5, 6, 1, 0, 2);
  window.setActivation(1);
  const errors = {
    files: {text},
    threadFatal() {
      assert.fail('ordinary configured Window services must succeed');
    },
  };
  const slots = [
    ...createGroup91WindowState(state, errors),
    ...createGroup92WindowImages(state, errors),
  ];
  assert.equal(slots.length, 13);
  for (const slot of slots)
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[slot.primary][slot.secondary]);
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 32,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread, memory: new AokanaBpMemory(new Uint8Array(0)), diagnostics: {}};
  const call = async (primary, secondary, args = [], pushed = 0) => {
    [handle, ...args].forEach((value) => push32(thread, value));
    assert.equal(
      await slots
        .find((slot) => slot.primary === primary && slot.secondary === secondary)
        .execute(context),
      0,
    );
    assert.equal(thread.stackIndex, pushed);
    const values = Array.from({length: pushed}, () => pop32(thread));
    return values.reverse();
  };
  const font = fonts.registerName(new TextEncoder().encode('Synthetic'), 1);
  await call(0x91, 0x88, [font, 8, 100, 0, 2, 0]);
  assert.equal(window.fontId, fonts.records[0].id);
  await call(0x91, 0x89, [25]);
  await call(0x91, 0x8a, [1]);
  await call(0x91, 0x8b, [1]);
  assert.deepEqual(await call(0x91, 0x8d, [], 3), [1, 3, 0]);
  assert.deepEqual(await call(0x91, 0x8e, [], 1), [1]);
  await call(0x91, 0x8c, [2, 1]);
  assert.deepEqual(await call(0x91, 0x8d, [], 3), [1, 2, 1]);
  assert.deepEqual(await call(0x91, 0x8e, [], 1), [0]);
  await call(0x91, 0x8a, [0]);
  assert.equal(surfaces.allocate(0, 2, 1, 2), 1);
  const source = surfaces.snapshot(0);
  bitmapWrite32(source, 0, 0xff204060);
  bitmapWrite32(source, 4, 0xff6080a0);
  const pixel = (bitmap, x, y) =>
    bitmap.storage.view.getUint32(bitmap.offset + y * bitmap.stride + x * 4, true);
  await call(0x92, 0x88, [1]);
  damage.clear();
  await call(0x92, 0x8a, [0xff112233]);
  assert.equal(damage.count, 0);
  assert.equal(pixel(window.compositionBitmap, 0, 0), 0xff112233);
  damage.clear();
  await call(0x92, 0x89, [1, 0, 0, 0x80, 0]);
  assert.deepEqual(damage.snapshot(), [
    {key: window.sortKey(), rectangle: {left: 6, top: 6, right: 7, bottom: 6}},
  ]);
  assert.equal(pixel(window.compositionBitmap, 1, 0), 0xff204060);
  await call(0x92, 0x8c, [1]);
  damage.clear();
  await call(0x92, 0x8d, [0, 1, 0, 0x80, 0]);
  assert.deepEqual(damage.snapshot(), [
    {key: window.sortKey(), rectangle: {left: 5, top: 7, right: 6, bottom: 7}},
  ]);
  assert.equal(pixel(window.compositionBitmap, 0, 1), 0xff204060);
  assert.equal(pixel(window.textBitmap, 1, 1), 0xff6080a0);
  assert.equal(window.setOverlayBitmap(0, source), 0);
  window.setOverlayPosition(0, 0, 0, 0);
  window.setOverlayEnabled(0, 1);
  window.configureInnerObjects(1);
  await call(0x92, 0x8e);
  assert.equal(window.overlayRectangle(0), null);
  assert.equal(pixel(window.textBitmap, 0, 1), 0);
  assert.equal(pixel(window.compositionBitmap, 0, 1), 0xff112233);
  assert.deepEqual(await call(0x91, 0x8d, [], 3), [1, 0, 0]);
  assert.equal(thread.stackIndex, 0);
});

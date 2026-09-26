import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, push32} from '../dist/engines/buriko/bp/state.js';
import {allocateBurikoBitmap} from '../dist/engines/buriko/native/bitmap.js';
import {bitmapRead32} from '../dist/engines/buriko/native/bitmap-scalar.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoDisplayDamage} from '../dist/engines/buriko/native/display-damage.js';
import {BurikoDisplayManager} from '../dist/engines/buriko/native/display-manager.js';
import {BurikoDisplayObjectEnvironment} from '../dist/engines/buriko/native/display-object.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {BurikoWindowDisplayObject} from '../dist/engines/buriko/native/display-window.js';
import {BurikoWindowDisplayState} from '../dist/engines/buriko/native/display-window-state.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {createGroup90SelectionBitmaps} from '../dist/engines/buriko/native/group-90-selection-bitmaps.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';

test('90:B4/B5 draw real text-layer bitmaps using retained insets and native record strides', () => {
  const compositor = new BurikoBitmapCompositor();
  compositor.defaultFormat = 1;
  const surfaces = new BurikoSurfaces(
    new BurikoNativeFonts(new BurikoNativeText()),
    compositor,
    new BurikoDistributedAllocator(1),
  );
  const bounds = {left: 0, top: 0, right: 63, bottom: 31},
    environment = new BurikoDisplayObjectEnvironment(
      compositor,
      new BurikoDisplayDamage(128, bounds),
    ),
    manager = new BurikoDisplayManager(environment, surfaces, new BurikoNativeDisplayState(64, 32));
  manager.bindDisplayContext({bitmap: allocateBurikoBitmap(64, 32, 1), bounds});
  const windows = new BurikoWindowDisplayState(manager),
    created = manager.createConfigured(
      'window',
      (order) => new BurikoWindowDisplayObject(windows, order),
      (window) => window.configureInitial(32, 24),
    );
  assert.equal(created.result, 0);
  const window = manager.find('window', created.handle);
  for (const [id, color] of [
    [0, 0x800000],
    [1, 0x008000],
  ]) {
    assert.equal(surfaces.allocate(id, 4, 4, 1), 1);
    surfaces.fill(id, color);
  }
  assert.equal(window.setTextRectangle({left: 3, top: 2, right: 28, bottom: 20}), 1);
  const slots = createGroup90SelectionBitmaps(manager, null),
    memory = new BurikoBpMemory(new Uint8Array(1024)),
    thread = new BurikoBpThread({id: 1, operandCapacity: 8, moduleCapacity: 0, frameCapacity: 0}),
    view = new DataView(memory.globalMemory.buffer);
  const words = (offset, values) =>
    values.forEach((v, i) => view.setInt32(offset + i * 4, v, true));
  // B4's second record begins at+16. B5 copies only the first three words
  // from each+64 record before looking up the Window.
  words(32, [1, 2, 0, -1, 10, 6, 1, -1]);
  words(128, [1, 2, 1, -1]);
  words(192, [10, 6, 0, -1]);
  const pixel = (x, y) => {
    const bitmap = window.compositionBitmap;
    return bitmapRead32(bitmap, bitmap.offset + y * bitmap.stride + x * 4) & 0xffffff;
  };
  for (const [index, slot] of slots.entries()) {
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x90][0xb4 + index]);
    environment.damage.clear();
    push32(thread, created.handle);
    push32(thread, 2);
    push32(thread, index === 0 ? 32 : 128);
    assert.equal(slot.execute({thread, memory, diagnostics: {}}), 0);
    assert.equal(thread.stackIndex, 0);
    assert.deepEqual(
      [pixel(5, 5), pixel(14, 9)],
      index === 0 ? [0x800000, 0x008000] : [0x008000, 0x800000],
    );
    assert.deepEqual(environment.damage.snapshot(), [
      {key: window.sortKey(), rectangle: window.textBitmapRectangle()},
    ]);
  }
});

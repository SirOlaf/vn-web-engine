import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {allocateAokanaBitmap} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {bitmapRead32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {AokanaDisplayManager} from '../dist/engines/buriko/games/aokana/native/display-manager.js';
import {AokanaDisplayObjectEnvironment} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {AokanaWindowDisplayObject} from '../dist/engines/buriko/games/aokana/native/display-window.js';
import {AokanaWindowDisplayState} from '../dist/engines/buriko/games/aokana/native/display-window-state.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {createGroup90SelectionBitmaps} from '../dist/engines/buriko/games/aokana/native/group-90-selection-bitmaps.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';

test('90:B4/B5 draw real text-layer bitmaps using retained insets and native record strides', () => {
  const compositor = new AokanaBitmapCompositor();
  compositor.defaultFormat = 1;
  const surfaces = new AokanaSurfaces(
    new AokanaNativeFonts(new AokanaNativeText()),
    compositor,
    new AokanaDistributedAllocator(1),
  );
  const bounds = {left: 0, top: 0, right: 63, bottom: 31},
    environment = new AokanaDisplayObjectEnvironment(
      compositor,
      new AokanaDisplayDamage(128, bounds),
    ),
    manager = new AokanaDisplayManager(environment, surfaces, new AokanaNativeDisplayState(64, 32));
  manager.bindDisplayContext({bitmap: allocateAokanaBitmap(64, 32, 1), bounds});
  const windows = new AokanaWindowDisplayState(manager),
    created = manager.createConfigured(
      'window',
      (order) => new AokanaWindowDisplayObject(windows, order),
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
    memory = new AokanaBpMemory(new Uint8Array(1024)),
    thread = new AokanaBpThread({id: 1, operandCapacity: 8, moduleCapacity: 0, frameCapacity: 0}),
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
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x90][0xb4 + index]);
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

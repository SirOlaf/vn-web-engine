import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {allocateAokanaBitmap} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {AokanaDisplayManager} from '../dist/engines/buriko/games/aokana/native/display-manager.js';
import {AokanaDisplayObjectEnvironment} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {AokanaWindowDisplayObject} from '../dist/engines/buriko/games/aokana/native/display-window.js';
import {AokanaWindowDisplayState} from '../dist/engines/buriko/games/aokana/native/display-window-state.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {createGroup90SelectionText} from '../dist/engines/buriko/games/aokana/native/group-90-selection-text.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {bitmapRead32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';

test('immediate selection text uses real address arrays, window colors and column rendering', async () => {
  const text = new AokanaNativeText();
  const createdFonts = [];
  const fonts = new AokanaNativeFonts(text, {
    async queryCharset() {
      return 1;
    },
    async create(parameters) {
      const size = Math.abs(parameters.height);
      createdFonts.push({name: parameters.face, size});
      return {
        faceName: parameters.face,
        familyName: parameters.face,
        averageWidth: 0,
        ascent: size,
        abc() {
          return [-1.25, 4.75, 0.5];
        },
        extent() {
          return size / 2;
        },
        rasterText(_text, width, height) {
          const bytes = new Uint8Array(width * height);
          for (let y = 0; y < height; y++) bytes.fill(255, y * width, y * width + size / 2);
          return {stride: width, bytes};
        },
      };
    },
    dispose() {},
  });
  fonts.rasterSettings.setQuality(-1);
  const compositor = new AokanaBitmapCompositor();
  compositor.defaultFormat = 1;
  const surfaces = new AokanaSurfaces(fonts, compositor, new AokanaDistributedAllocator(1));
  const bounds = {left: 0, top: 0, right: 63, bottom: 31};
  const environment = new AokanaDisplayObjectEnvironment(
    compositor,
    new AokanaDisplayDamage(128, bounds),
  );
  const display = new AokanaNativeDisplayState(64, 32),
    manager = new AokanaDisplayManager(environment, surfaces, display);
  manager.bindDisplayContext({bitmap: allocateAokanaBitmap(64, 32, 1), bounds});
  const windows = new AokanaWindowDisplayState(manager);
  const created = manager.createConfigured(
    'window',
    (order) => new AokanaWindowDisplayObject(windows, order),
    (window) => window.configureInitial(32, 32),
  );
  assert.equal(created.result, 0);
  const window = manager.find('window', created.handle);
  window.setBackgroundEnabled(1);
  assert.equal(await window.configureFont(text.encodeWide('Synthetic', 0), 8, 100, 0), 0);
  assert.equal(window.setTextRegion(0, 0, 32, 16), 1);

  window.setTextCursor(3, 4);
  window.setTextTransparency(128);
  window.setTextEnabled(0);
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 64,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const memory = new AokanaBpMemory(new Uint8Array(1024)),
    view = new DataView(memory.globalMemory.buffer);
  for (let i = 0; i < 3; i++) {
    memory.globalMemory.set(text.encodeWide(String.fromCharCode(65 + i), 1), 32 + i * 8);
    view.setUint32(128 + i * 4, 32 + i * 8, true);
  }
  const colors = [0xff0000, 0x00ff00, 0x0000ff];
  for (let i = 0; i < 16; i++) view.setUint32(256 + i * 4, colors[i % 3], true);
  const context = {thread, memory, diagnostics: {}};
  const slots = createGroup90SelectionText(windows, {
    threadFatal() {
      assert.fail('ordinary selection should succeed');
    },
  });
  for (const slot of slots)
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x90][slot.secondary]);
  const call = async (secondary, args) => {
    args.forEach((value) => push32(thread, value));
    assert.equal(await slots.find((slot) => slot.secondary === secondary).execute(context), 0);
    assert.equal(thread.stackIndex, 0);
  };
  const pixel = (bitmap, x, y) => bitmapRead32(bitmap, bitmap.offset + y * bitmap.stride + x * 4);
  await call(0xa7, [created.handle, 256]);
  await call(0xa1, [created.handle, 3, 128, 2, 0, 0xffffff]);
  // Glyph coverage255 divides channels by256; 03DCC0 forces opaque alpha
  // across the full format1 scratch copied into the Window's format2 bitmap.
  assert.equal(pixel(window.textBitmap, 0, 0), 0xfffe0000);
  assert.equal(pixel(window.textBitmap, 16, 0), 0xff00fe00);
  assert.equal(pixel(window.textBitmap, 0, 8), 0xff0000fe);
  assert.equal(pixel(window.textBitmap, 4, 0), 0xff000000);
  assert.deepEqual(window.getTextCursor(), {x: 3, y: 4});
  assert.ok(
    environment.damage
      .snapshot()
      .some(
        (entry) =>
          entry.key === window.sortKey() &&
          entry.rectangle.right === 31 &&
          entry.rectangle.bottom === 31,
      ),
  );
  assert.notEqual(pixel(window.compositionBitmap, 0, 0), 0);
  await call(0xa7, [created.handle, 0]);
  await call(0xa1, [created.handle, 3, 128, 2, 1, 0xffffff]);
  // Width4 centered within16-pixel columns begins at6 and22.
  assert.equal(pixel(window.textBitmap, 0, 0), 0);
  assert.equal(pixel(window.textBitmap, 6, 0), 0xfffefefe);
  assert.equal(pixel(window.textBitmap, 22, 0), 0xfffefefe);
  assert.equal(pixel(window.textBitmap, 6, 8), 0xfffefefe);
  assert.deepEqual(window.getTextCursor(), {x: 3, y: 4});
});

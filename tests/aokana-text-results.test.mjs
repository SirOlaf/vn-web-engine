import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, push32, pop32} from '../dist/engines/buriko/bp/state.js';
import {allocateBurikoBitmap} from '../dist/engines/buriko/native/bitmap.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {BurikoDisplayDamage} from '../dist/engines/buriko/native/display-damage.js';
import {BurikoDisplayManager} from '../dist/engines/buriko/native/display-manager.js';
import {BurikoDisplayObjectEnvironment} from '../dist/engines/buriko/native/display-object.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {BurikoWindowDisplayObject} from '../dist/engines/buriko/native/display-window.js';
import {BurikoWindowDisplayState} from '../dist/engines/buriko/native/display-window-state.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {createGroup92TextResults} from '../dist/engines/buriko/native/group-92-text-results.js';
import {
  drawBurikoHorizontalTextToBitmap,
  BURIKO_DISABLED_HORIZONTAL_TEXT_EFFECT,
} from '../dist/engines/buriko/native/text-layout-pipeline.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';

test('text result services consume actual layout registries and cached glyph ABC with shared alternate font', async () => {
  let tick = 0;
  const clock = new BurikoNativeClock(() => tick),
    text = new BurikoNativeText();
  const createdFonts = [];
  const fonts = new BurikoNativeFonts(text, {
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
  const compositor = new BurikoBitmapCompositor();
  compositor.defaultFormat = 1;
  const surfaces = new BurikoSurfaces(fonts, compositor, new BurikoDistributedAllocator(1));
  const bounds = {left: 0, top: 0, right: 63, bottom: 31};
  const environment = new BurikoDisplayObjectEnvironment(
    compositor,
    new BurikoDisplayDamage(128, bounds),
  );
  const display = new BurikoNativeDisplayState(64, 32),
    manager = new BurikoDisplayManager(environment, surfaces, display);
  manager.bindDisplayContext({bitmap: allocateBurikoBitmap(64, 32, 1), bounds});
  const windows = new BurikoWindowDisplayState(manager);
  const created = manager.createConfigured(
    'window',
    (order) => new BurikoWindowDisplayObject(windows, order),
    (window) => window.configureInitial(32, 16),
  );
  assert.equal(created.result, 0);
  const window = manager.find('window', created.handle);
  window.setBackgroundEnabled(1);
  assert.equal(await window.configureFont(text.encodeWide('Synthetic', 0), 8, 100, 0), 0);
  assert.equal(windows.textLayout.setFadeTiming(2, 10), true);
  const state = windows.textLayout;
  const registered = fonts.registerName(text.encodeWide('Synthetic', 0), 1);
  const alternate = fonts.registerName(text.encodeWide('Alternate', 0), 1);
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 64,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const memory = new BurikoBpMemory(new Uint8Array(4096)),
    view = new DataView(memory.globalMemory.buffer);
  memory.globalMemory.set(text.encodeWide('A<l>B</l>', 1), 32);
  memory.globalMemory.set(text.encodeWide('AB', 1), 64);
  const context = {thread, memory, diagnostics: {}};
  const slots = createGroup92TextResults(windows, {
    threadFatal() {
      assert.fail('ordinary result service should succeed');
    },
  });
  assert.deepEqual(
    slots.map((slot) => slot.secondary),
    [0x94, 0x95, 0x99, 0x9b, 0x9d, 0x9e, 0x9f],
  );
  for (const slot of slots)
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x92][slot.secondary]);
  const call = async (secondary, args, pushes = true) => {
    const depth = thread.stackIndex;
    args.forEach((value) => push32(thread, value));
    assert.equal(await slots.find((slot) => slot.secondary === secondary).execute(context), 0);
    assert.equal(thread.stackIndex, depth + Number(pushes));
    return pushes ? pop32(thread) : undefined;
  };
  assert.equal(await call(0x9d, [alternate, 12, 100, 0, 0]), 0);
  await call(0x9f, [0x123456], false);
  state.field1D1DBC = 1;
  const lineOutput = {value: 0},
    destination = allocateBurikoBitmap(64, 32, 2);
  assert.equal(
    await drawBurikoHorizontalTextToBitmap(state, {
      destination,
      lineOutput,
      x: 1,
      y: 2,
      source: {bytes: memory.globalMemory, offset: 32},
      readingEnabled: 0,
      annotations: null,
      fontId: window.fontId,
      proportional: 0,
      wrapping: 0,
      lineSpacingPercent: 0,
      color: 0xabcdef,
      readingColor: 0xabcdef,
      effect: BURIKO_DISABLED_HORIZONTAL_TEXT_EFFECT,
    }),
    1,
  );
  assert.ok(createdFonts.some((font) => font.name === 'Alternate' && font.size === 12));
  assert.equal(await call(0x94, [0, lineOutput.value]), 1);
  assert.equal(await call(0x94, [256, lineOutput.value]), 1);
  assert.equal(view.getUint32(256, true), 8);
  assert.equal(await call(0x94, [0, lineOutput.value]), 0);
  assert.equal(await call(0x95, [created.handle]), 8);
  await call(0x9b, [272, 0x100], false);
  assert.deepEqual([view.getInt32(272, true), view.getInt32(276, true)], [9, 2]);
  await call(0x9b, [280, 0x101], false);
  assert.equal(view.getUint32(280, true), 0xabcdef);
  assert.equal(await call(0x9e, [512]), 1);
  assert.equal(memory.globalMemory[512], 66);
  assert.ok(memory.globalMemory.subarray(513, 608).every((value) => value === 0));
  assert.ok(memory.globalMemory.subarray(608, 632).every((value) => value === 0));
  assert.deepEqual([view.getInt32(632, true), view.getInt32(636, true)], [5, 2]);
  assert.equal(await call(0x9e, [0]), 0);
  assert.equal(state.linkRegions.length, 0);
  assert.equal(await call(0x99, [768, 800, 64, registered, 8, 100, 0]), 0);
  assert.equal(view.getUint32(800, true), 2);
  assert.deepEqual(
    Array.from({length: 6}, (_, index) => view.getInt32(768 + index * 4, true)),
    [0, 5, 1, 0, 5, 1],
  );
  assert.equal(await call(0x99, [0, 804, 64, registered, 8, 100, 0]), 0);
  assert.equal(view.getUint32(804, true), 0);
  assert.equal(thread.stackIndex, 0);
});

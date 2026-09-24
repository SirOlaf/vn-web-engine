import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, push32, pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
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
import {createGroup90SelectionExtended} from '../dist/engines/buriko/games/aokana/native/group-90-selection-extended.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {bitmapRead32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';

import {AokanaBpScheduler} from '../dist/engines/buriko/games/aokana/bp/scheduler.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {AokanaNativeCursorMotion} from '../dist/engines/buriko/games/aokana/native/cursor-motion.js';
import {AokanaNativeInput} from '../dist/engines/buriko/games/aokana/native/input.js';
import {AokanaNativeNotifications} from '../dist/engines/buriko/games/aokana/native/notification-queue.js';
import {
  AokanaProcedureState,
  AokanaWindowMessages,
} from '../dist/engines/buriko/games/aokana/native/procedure.js';
import {AokanaSelectionState} from '../dist/engines/buriko/games/aokana/native/selection-state.js';

test('extended selections retain real marker overlays and complete interactive and timed procedures', async () => {
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
  // Constructor dimensions describe the desktop; configure the actual client/logical transform.
  assert.equal(display.setSizePreset(display.selectedSizePreset, 64, 32), 0);
  display.requestedWidth = 64;
  display.requestedHeight = 32;
  display.refreshPointerStep();
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

  window.setLayer(3);
  let tick = 0;
  const clock = new AokanaNativeClock(() => tick),
    input = new AokanaNativeInput(display, clock);
  input.foreground = true;
  input.pointerAvailable = true;
  input.pointerClientX = 2;
  input.pointerClientY = 1;
  const moves = [];
  const cursor = new AokanaNativeCursorMotion(input, clock, {
    setClientPosition(x, y) {
      moves.push([x, y]);
      input.pointerClientX = x;
      input.pointerClientY = y;
      return true;
    },
  });
  const procedures = new AokanaProcedureState(),
    waits = new AokanaWindowMessages(),
    notifications = new AokanaNativeNotifications(),
    settings = new AokanaSelectionState();
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 64,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const scheduler = new AokanaBpScheduler(
    new AokanaBpThread({id: 0, operandCapacity: 0, moduleCapacity: 0, frameCapacity: 0}),
    () => 0,
  );
  const node = scheduler.append(thread),
    memory = new AokanaBpMemory(new Uint8Array(512)),
    view = new DataView(memory.globalMemory.buffer);
  for (let i = 0; i < 3; i++) {
    memory.globalMemory.set(text.encodeWide(String.fromCharCode(65 + i), 1), 32 + i * 8);
    view.setUint32(128 + i * 4, 32 + i * 8, true);
  }
  assert.equal(surfaces.allocate(1, 2, 2, 2), 1);
  assert.equal(surfaces.allocate(2, 2, 2, 2), 1);
  assert.equal(surfaces.fill(1, 0xff00ffff), 1);
  assert.equal(surfaces.fill(2, 0xffff00ff), 1);
  const slots = createGroup90SelectionExtended(
    windows,
    scheduler,
    procedures,
    clock,
    input,
    waits,
    notifications,
    cursor,
    settings,
    {
      threadFatal() {
        assert.fail('ordinary extended selection should succeed');
      },
    },
  );
  for (const slot of slots)
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x90][slot.secondary]);
  const call = async (secondary, selected) => {
    for (const value of [created.handle, 3, 128, 2, 0, 0xffffff, selected, 1, 1, 4, 0, 2, 2, 0])
      push32(thread, value);
    assert.equal(
      await slots
        .find((slot) => slot.secondary === secondary)
        .execute({thread, memory, diagnostics: {}}),
      2,
    );
    assert.equal(thread.stackIndex, 0);
  };
  await call(0xa2, 0);
  assert.equal(await node.pollProcess(false), 0);
  assert.deepEqual(window.overlayRectangle(1), {left: 4, top: 0, right: 5, bottom: 1});
  assert.deepEqual(window.overlayRectangle(2), {left: 6, top: 0, right: 7, bottom: 1});
  input.pointerClientX = 18;
  waits.dispatch(0x200, 0n, 0n);
  assert.equal(await node.pollProcess(false), 0);
  assert.deepEqual(notifications.take(), {type: 0x10000002, value1: 1, value2: 1});
  assert.deepEqual(notifications.take(), {type: 0x10000001, value1: 1, value2: 1});
  assert.deepEqual(window.overlayRectangle(1), {left: 20, top: 0, right: 21, bottom: 1});
  assert.deepEqual(window.overlayRectangle(2), {left: 22, top: 0, right: 23, bottom: 1});
  const pixel = (x, y) =>
    bitmapRead32(window.compositionBitmap, y * window.compositionBitmap.stride + x * 4) & 0xffffff;
  assert.equal(pixel(20, 0), 0x00ffff);
  assert.equal(pixel(22, 0), 0xff00ff);
  input.recordKeyDown(1);
  assert.equal(await node.pollProcess(false), 1);
  assert.equal(pop32(thread), 1);
  assert.equal(pop32(thread), 1);
  assert.equal(waits.consume(thread, 0x200), null);
  // Marker copies remain owned by the Window after normal process cleanup.
  assert.deepEqual(window.overlayRectangle(1), {left: 20, top: 0, right: 21, bottom: 1});
  tick = 1000;
  await call(0xa3, 2);
  assert.equal(await node.pollProcess(false), 0);
  assert.deepEqual(window.overlayRectangle(0), {left: 0, top: 8, right: 3, bottom: 15});
  assert.deepEqual(window.overlayRectangle(1), {left: 4, top: 8, right: 5, bottom: 9});
  assert.deepEqual(window.overlayRectangle(2), {left: 6, top: 8, right: 7, bottom: 9});
  assert.equal(pixel(0, 8), 0xfe0000);
  for (let step = 1; step < 20; step++) {
    tick = 1000 + step * 50;
    assert.equal(await node.pollProcess(false), 0);
  }
  assert.equal(pixel(0, 8), 0xfefe00);
  assert.equal(pixel(4, 8), 0x00ffff);
  tick = 2000;
  assert.equal(await node.pollProcess(false), 1);
  assert.equal(pop32(thread), 2);
  assert.equal(pop32(thread), 2);
  assert.equal(thread.stackIndex, 0);
  assert.equal(waits.consume(thread, 0x200), null);
  assert.equal(procedures.pointerPriorityAllowed(window.sortKey() - 1), true);
  assert.equal(notifications.take(), null);
});

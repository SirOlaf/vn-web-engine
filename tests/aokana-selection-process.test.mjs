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
import {createGroup90SelectionProcess} from '../dist/engines/buriko/games/aokana/native/group-90-selection-process.js';
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

test('selection procedure uses real capture, timed highlighting, cursor motion and scheduler completion', async () => {
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
  const slots = createGroup90SelectionProcess(
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
        assert.fail('ordinary selection should succeed');
      },
    },
  );
  for (const slot of slots)
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x90][slot.secondary]);
  const call = async (secondary, args, result = 0) => {
    args.forEach((value) => push32(thread, value));
    assert.equal(
      await slots
        .find((slot) => slot.secondary === secondary)
        .execute({thread, memory, diagnostics: {}}),
      result,
    );
    assert.equal(thread.stackIndex, 0);
  };
  await call(0xa4, [0xff0000, 0x00ff00]);
  await call(0xa5, [10]);
  await call(0xa6, [1, 0, 20, 100]);
  await call(0xa0, [created.handle, 3, 128, 2, 0, 0xffffff, 0, 1], 2);
  assert.equal(procedures.pointerPriorityAllowed(window.sortKey() - 1), false);
  assert.equal(input.keyCaptureAllowed(1), false);
  assert.equal(await node.pollProcess(false), 0);
  assert.deepEqual(window.overlayRectangle(0), {left: 0, top: 0, right: 3, bottom: 7});
  const pixel = (bitmap, x, y) => bitmapRead32(bitmap, bitmap.offset + y * bitmap.stride + x * 4);
  assert.equal(pixel(window.compositionBitmap, 0, 0) & 0xffffff, 0xfe0000);
  tick = 10;
  assert.equal(await node.pollProcess(false), 0);
  assert.equal(pixel(window.compositionBitmap, 0, 0) & 0xffffff, 0x00fe00);
  // Configured wheel navigation starts the existing cursor-motion owner, then real
  // window-message delivery makes selection follow the resulting pointer position.
  input.recordKeyDown(15);
  assert.equal(await node.pollProcess(false), 0);
  assert.equal(cursor.active, true);
  assert.deepEqual(notifications.take(), {type: 0x10000001, value1: 1, value2: 0});
  tick = 20;
  cursor.advance();
  tick = 30;
  cursor.advance();
  assert.deepEqual(moves.at(-1), [2, 12]);
  waits.dispatch(0x200, 0n, 0n);
  assert.equal(await node.pollProcess(false), 0);
  assert.deepEqual(notifications.take(), {type: 0x10000002, value1: 1, value2: 2});
  assert.deepEqual(notifications.take(), {type: 0x10000001, value1: 1, value2: 2});
  assert.deepEqual(window.overlayRectangle(0), {left: 0, top: 8, right: 3, bottom: 15});
  input.recordKeyDown(38);
  assert.equal(await node.pollProcess(false), 0);
  assert.deepEqual(notifications.take(), {type: 0x10000001, value1: 1, value2: 0});
  input.recordKeyDown(13);
  assert.equal(await node.pollProcess(false), 1);
  assert.equal(pop32(thread), 0);
  assert.equal(pop32(thread), 0);
  assert.equal(thread.stackIndex, 0);
  assert.equal(input.keyCaptureAllowed(1), true);
  assert.equal(procedures.pointerPriorityAllowed(window.sortKey() - 1), true);
  assert.equal(waits.consume(thread, 0x200), null);
  assert.equal(notifications.take(), null);
});

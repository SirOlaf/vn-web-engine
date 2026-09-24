import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpScheduler} from '../dist/engines/buriko/games/aokana/bp/scheduler.js';
import {AokanaBpThread, push32, pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {allocateAokanaBitmap} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {AokanaDisplayManager} from '../dist/engines/buriko/games/aokana/native/display-manager.js';
import {AokanaDisplayObjectEnvironment} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {AokanaWindowDisplayObject} from '../dist/engines/buriko/games/aokana/native/display-window.js';
import {AokanaWindowDisplayState} from '../dist/engines/buriko/games/aokana/native/display-window-state.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {createGroup92TextDisplay} from '../dist/engines/buriko/games/aokana/native/group-92-text-display.js';
import {AokanaVerticalTextDisplayProcess} from '../dist/engines/buriko/games/aokana/native/text-display-vertical-process.js';
import {createGroup91TextDisplay} from '../dist/engines/buriko/games/aokana/native/group-91-text-display.js';
import {AokanaNativeNotifications} from '../dist/engines/buriko/games/aokana/native/notification-queue.js';
import {AokanaNativeInput} from '../dist/engines/buriko/games/aokana/native/input.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
import {AokanaProcedureState} from '../dist/engines/buriko/games/aokana/native/procedure.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';

test('extended message owns shared glyph nodes, tick fades and scaled saved-background emission', async () => {
  let tick = 0;
  const clock = new AokanaNativeClock(() => tick),
    text = new AokanaNativeText();
  const fonts = new AokanaNativeFonts(text, {
    async queryCharset() {
      return 1;
    },
    async create(parameters) {
      const size = Math.abs(parameters.height);
      return {
        faceName: parameters.face,
        familyName: parameters.face,
        averageWidth: 0,
        ascent: size,
        abc() {
          return [0, size / 2, 0];
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
    (window) => window.configureInitial(32, 16),
  );
  assert.equal(created.result, 0);
  const window = manager.find('window', created.handle);
  window.setBackgroundEnabled(1);
  assert.equal(await window.configureFont(text.encodeWide('Synthetic', 0), 8, 100, 0), 0);
  assert.equal(windows.textLayout.setFadeTiming(2, 10), true);
  const input = new AokanaNativeInput(display, clock);
  input.foreground = true;
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 32,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const scheduler = new AokanaBpScheduler(
    new AokanaBpThread({id: 0, operandCapacity: 0, moduleCapacity: 0, frameCapacity: 0}),
    () => 0,
  );
  const node = scheduler.append(thread),
    procedures = new AokanaProcedureState();
  const memory = new AokanaBpMemory(new Uint8Array(128));
  memory.globalMemory.set(text.encodeWide('A', 1), 32);
  memory.globalMemory.set(text.encodeWide('B', 1), 48);
  const context = {thread, memory, diagnostics: {}};
  const notifications = new AokanaNativeNotifications();
  const slots = createGroup91TextDisplay(
    windows,
    scheduler,
    procedures,
    clock,
    input,
    notifications,
    {
      threadFatal() {
        assert.fail('ordinary extended message should succeed');
      },
    },
  );
  for (const slot of slots)
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x91][slot.secondary]);
  windows.textLayout.field1C9100 = 2;
  windows.textLayout.field1C90E8 = 4;
  const start = async (secondary, address) => {
    const args =
      secondary === 0x90
        ? [created.handle, address, 0xffffff, 0, 0, 1, 1, 0, 0, 0]
        : [created.handle, address, 0xffffff, 0, 0, 0, 1, 1, 0, 0, 0];
    args.forEach((value) => push32(thread, value));
    assert.equal(await slots.find((slot) => slot.secondary === secondary).execute(context), 2);
    assert.equal(input.keyCaptureAllowed(1), false);
  };
  const pixel = (x) => {
    const bitmap = window.textBitmap;
    return bitmap.storage.view.getUint32(bitmap.offset + x * 4, true);
  };
  await start(0x90, 32);
  assert.deepEqual(window.getTextCursor(), {x: 4, y: 0});
  assert.equal(await node.pollProcess(false), 0);
  assert.equal(pixel(0), 0);
  assert.deepEqual(notifications.take(), {type: 0x30000002, value1: 0, value2: 0});
  tick = 2;
  assert.equal(await node.pollProcess(false), 0);
  const partial = pixel(0);
  assert.notEqual(partial, 0);
  tick = 3;
  assert.equal(await node.pollProcess(false), 0);
  const complete = pixel(0);
  assert.notEqual(complete, partial);
  assert.equal(await node.pollProcess(false), 1);
  assert.equal(pop32(thread), 0);
  assert.equal(input.keyCaptureAllowed(1), true);
  assert.equal(notifications.take(), null);
  // The second real process snapshots the retained first glyph; Q16 half-speed
  // makes eight raw milliseconds span the four-millisecond native fade.
  windows.textLayout.field1D1E54 = 1;
  windows.textLayout.field1D27A4 = 1;
  windows.textLayout.field1C90FC = 32768;
  await start(0x92, 48);
  assert.deepEqual(window.getTextCursor(), {x: 8, y: 0});
  assert.equal(await node.pollProcess(false), 0);
  assert.equal(pixel(0), complete);
  assert.equal(pixel(4), 0);
  assert.deepEqual(notifications.take(), {type: 0x30000002, value1: 0, value2: 0});
  tick = 7;
  assert.equal(await node.pollProcess(false), 0);
  assert.equal(pixel(0), complete);
  const secondPartial = pixel(4);
  assert.notEqual(secondPartial, 0);
  tick = 11;
  assert.equal(await node.pollProcess(false), 0);
  assert.equal(pixel(0), complete);
  assert.notEqual(pixel(4), secondPartial);
  assert.equal(await node.pollProcess(false), 1);
  assert.equal(pop32(thread), 0);
  assert.equal(node.process, null);
  assert.equal(thread.stackIndex, 0);
  assert.equal(input.keyCaptureAllowed(1), true);
  assert.equal(notifications.take(), null);
  // Selector1 chooses the actual vertical builder for a vertical window.
  windows.textLayout.field1D1E54 = 0;
  windows.textLayout.field1D27A4 = 0;
  windows.textLayout.field1C90FC = 65536;
  window.setWritingDirection(1);
  window.setTextCursor(16, 0);
  memory.globalMemory.set([0xef, 0x40, 0], 64);
  const [directed] = createGroup92TextDisplay(
    windows,
    scheduler,
    procedures,
    clock,
    input,
    notifications,
    {
      threadFatal() {
        assert.fail('ordinary directed message should succeed');
      },
    },
  );
  assert.equal(directed.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x92][0x90]);
  for (const value of [created.handle, 64, 0xffffff, 0, 0xffffff, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1])
    push32(thread, value);
  assert.equal(await directed.execute(context), 2);
  assert.ok(node.process instanceof AokanaVerticalTextDisplayProcess);
  assert.deepEqual(window.getTextCursor(), {x: 16, y: 8});
  assert.equal(await node.pollProcess(false), 0);
  assert.notEqual(pixel(9), 0);
  assert.deepEqual(notifications.take(), {type: 0x30000002, value1: 0, value2: 0});
  assert.equal(await node.pollProcess(false), 1);
  assert.equal(pop32(thread), 0);
  assert.equal(thread.stackIndex, 0);
  assert.equal(input.keyCaptureAllowed(1), true);
  assert.equal(notifications.take(), null);
});

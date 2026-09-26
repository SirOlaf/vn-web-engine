import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpScheduler} from '../dist/engines/buriko/bp/scheduler.js';
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
import {createGroup90TextDisplay} from '../dist/engines/buriko/native/group-90-text-display.js';
import {BurikoNativeInput} from '../dist/engines/buriko/native/input.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';
import {BurikoProcedureState} from '../dist/engines/buriko/native/procedure.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';

test('base window message uses scheduled glyph phases, real fade composition, input capture and cleanup', async () => {
  let tick = 0;
  const clock = new BurikoNativeClock(() => tick),
    text = new BurikoNativeText();
  const fonts = new BurikoNativeFonts(text, {
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
  const input = new BurikoNativeInput(display, clock);
  input.foreground = true;
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 32,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const scheduler = new BurikoBpScheduler(
    new BurikoBpThread({id: 0, operandCapacity: 0, moduleCapacity: 0, frameCapacity: 0}),
    () => 0,
  );
  const node = scheduler.append(thread),
    procedures = new BurikoProcedureState();
  const memory = new BurikoBpMemory(new Uint8Array(128));
  // EF40/EF41 use the native successful wide-code bypass through03F840.
  memory.globalMemory.set([0xef, 0x40, 12, 0xef, 0x41, 0], 32);
  const context = {thread, memory, diagnostics: {}};
  const [slot] = createGroup90TextDisplay(windows, scheduler, procedures, clock, input, {
    threadFatal() {
      assert.fail('ordinary message should succeed');
    },
  });
  assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x90][0x90]);
  for (const value of [created.handle, 32, 0xffffff, 0, 1, 1]) push32(thread, value);
  assert.equal(slot.execute(context), 2);
  assert.equal(input.keyCaptureAllowed(1), false);
  const pixel = () => {
    const bitmap = window.textBitmap;
    return bitmap.storage.view.getUint32(bitmap.offset, true);
  };
  assert.equal(await node.pollProcess(false), 0);
  assert.notEqual(window.overlayRectangle(0), null);
  assert.equal(pixel(), 0);
  tick = 50;
  assert.equal(await node.pollProcess(false), 0);
  assert.equal(window.overlayRectangle(0), null);
  assert.notEqual(pixel(), 0);
  assert.deepEqual(window.getTextCursor(), {x: 8, y: 0});
  tick = 100;
  assert.equal(await node.pollProcess(false), 0);
  tick = 110;
  assert.equal(await node.pollProcess(false), 0);
  assert.equal(pixel(), 0);
  assert.deepEqual(window.getTextCursor(), {x: 0, y: 0});
  tick = 120;
  assert.equal(await node.pollProcess(false), 0);
  assert.notEqual(window.overlayRectangle(0), null);
  tick = 170;
  assert.equal(await node.pollProcess(false), 0);
  assert.notEqual(pixel(), 0);
  tick = 220;
  assert.equal(await node.pollProcess(false), 0);
  // The first wait poll clears ordinary reveal input; a fresh Enter completes it.
  input.recordKeyDown(13);
  assert.equal(await node.pollProcess(false), 1);
  assert.equal(node.process, null);
  assert.equal(pop32(thread), 1);
  assert.equal(thread.stackIndex, 0);
  assert.equal(input.keyCaptureAllowed(1), true);
  assert.equal(input.releasePointerCapture(2), false);
  assert.equal(manager.redraw.pending, 1);
  assert.ok(environment.damage.snapshot().length > 0);
});

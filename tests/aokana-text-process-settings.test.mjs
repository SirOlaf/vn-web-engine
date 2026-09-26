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
import {createGroup90TextProcessSettings} from '../dist/engines/buriko/native/group-90-text-process-settings.js';
import {createGroup90TextDisplay} from '../dist/engines/buriko/native/group-90-text-display.js';
import {BurikoNativeInput} from '../dist/engines/buriko/native/input.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';
import {BurikoProcedureState} from '../dist/engines/buriko/native/procedure.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';

test('message settings control real capture, glyph timing, fade, redraw and automatic/input waits', async () => {
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

  const settings = createGroup90TextProcessSettings(windows.textLayout, {
    threadFatal() {
      assert.fail('ordinary message settings should succeed');
    },
  });
  assert.deepEqual(
    settings.map((entry) => entry.secondary),
    [0x91, 0x92, 0x94, 0x95, 0x96, 0x97, 0x99, 0x9b, 0x9c, 0x9d, 0x9f],
  );
  for (const entry of settings)
    assert.equal(entry.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x90][entry.secondary]);
  const set = (secondary, args) => {
    const depth = thread.stackIndex;
    args.forEach((value) => push32(thread, value));
    assert.equal(settings.find((entry) => entry.secondary === secondary).execute(context), 0);
    assert.equal(thread.stackIndex, depth);
  };
  set(0x91, [1, 3]);
  set(0x92, [1]);
  set(0x94, [20]);
  set(0x95, [3, 7]);
  set(0x96, [2, 5]);
  set(0x97, [1, 30]);
  set(0x99, [10]);
  set(0x9b, [1, 100]);
  set(0x9c, [1]);
  set(0x9d, [25, 25, 128]);
  set(0x9f, [0]);
  assert.deepEqual([windows.textLayout.scrollSteps, windows.textLayout.scrollInterval], [3, 7]);
  const start = (source) => {
    for (const value of [created.handle, source, 0xffffff, 0, 1, 1]) push32(thread, value);
    assert.equal(slot.execute(context), 2);
  };
  start(32);
  const token = (3 << 16) | 0xffff;
  assert.equal(input.keyCaptureAllowed(token - 1), false);
  assert.equal(input.keyCaptureAllowed(token), true);
  const pixel = () => {
    const bitmap = window.textBitmap;
    return bitmap.storage.view.getUint32(bitmap.offset, true);
  };
  assert.equal(await node.pollProcess(false), 0);
  assert.notEqual(window.overlayRectangle(0), null);
  assert.equal(manager.redraw.pending, 0);
  assert.equal(pixel(), 0);
  set(0x92, [0]);
  tick = 20;
  assert.equal(await node.pollProcess(false), 0);
  assert.notEqual(pixel(), 0);
  assert.equal(manager.redraw.pending, 1);
  tick = 40;
  assert.equal(await node.pollProcess(false), 0);
  tick = 45;
  assert.equal(await node.pollProcess(false), 0);
  assert.equal(pixel(), 0);
  tick = 50;
  assert.equal(await node.pollProcess(false), 0);
  assert.notEqual(window.overlayRectangle(0), null);
  tick = 70;
  assert.equal(await node.pollProcess(false), 0);
  assert.notEqual(pixel(), 0);
  tick = 90;
  assert.equal(await node.pollProcess(false), 0);
  assert.equal(node.process.deadline, 90);
  tick = 100;
  assert.equal(await node.pollProcess(false), 0);
  assert.equal(node.process.deadline, 110);
  tick = 110;
  assert.equal(await node.pollProcess(false), 0);
  assert.equal(node.process.deadline, 120);
  tick = 130;
  assert.equal(await node.pollProcess(false), 0);
  tick = 131;
  assert.equal(await node.pollProcess(false), 1);
  assert.equal(pop32(thread), 0);
  assert.equal(input.keyCaptureAllowed(token - 1), true);
  // A new ordinary message now consumes the configured input-to-finish policy,
  // so fresh Enter completes it even during the initial wait.
  set(0x9f, [1]);
  start(64);
  input.recordKeyDown(13);
  assert.equal(await node.pollProcess(false), 1);
  assert.equal(pop32(thread), 1);
  assert.equal(node.process, null);
  assert.equal(thread.stackIndex, 0);
  assert.equal(input.keyCaptureAllowed(token - 1), true);
});

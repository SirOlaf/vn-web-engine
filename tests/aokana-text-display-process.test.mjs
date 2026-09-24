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
import {createGroup90TextDisplay} from '../dist/engines/buriko/games/aokana/native/group-90-text-display.js';
import {AokanaNativeInput} from '../dist/engines/buriko/games/aokana/native/input.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
import {AokanaProcedureState} from '../dist/engines/buriko/games/aokana/native/procedure.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';

test('base window message uses scheduled glyph phases, real fade composition, input capture and cleanup', async () => {
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
  // EF40/EF41 use the native successful wide-code bypass through03F840.
  memory.globalMemory.set([0xef, 0x40, 12, 0xef, 0x41, 0], 32);
  const context = {thread, memory, diagnostics: {}};
  const [slot] = createGroup90TextDisplay(windows, scheduler, procedures, clock, input, {
    threadFatal() {
      assert.fail('ordinary message should succeed');
    },
  });
  assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x90][0x90]);
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

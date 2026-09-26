import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, push32, pop32} from '../dist/engines/buriko/bp/state.js';
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
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {BurikoNativeInput} from '../dist/engines/buriko/native/input.js';
import {BurikoNativeCursor} from '../dist/engines/buriko/native/engine-dialogs.js';
import {BurikoCursorPolicy} from '../dist/engines/buriko/native/cursor-policy.js';
import {BurikoProcedureState} from '../dist/engines/buriko/native/procedure.js';
import {BurikoIndependentProcedures} from '../dist/engines/buriko/native/independent-procedure.js';
import {BurikoIndependentIconState} from '../dist/engines/buriko/native/independent-icon.js';
import {createGroup90IndependentIcons} from '../dist/engines/buriko/native/group-90-independent-icons.js';
import {createGroup91IndependentIconEx} from '../dist/engines/buriko/native/group-91-independent-icon-ex.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';

test('IconEx animates and moves actual Window inner Sprites through VM groups and independent messages', async () => {
  const text = new BurikoNativeText(),
    compositor = new BurikoBitmapCompositor();
  compositor.defaultFormat = 1;
  const surfaces = new BurikoSurfaces(
    new BurikoNativeFonts(text),
    compositor,
    new BurikoDistributedAllocator(1),
  );
  const bounds = {left: 0, top: 0, right: 63, bottom: 31},
    environment = new BurikoDisplayObjectEnvironment(
      compositor,
      new BurikoDisplayDamage(128, bounds),
    );
  const display = new BurikoNativeDisplayState(64, 32),
    manager = new BurikoDisplayManager(environment, surfaces, display);
  assert.equal(display.setSizePreset(display.selectedSizePreset, 64, 32), 0);
  display.requestedWidth = 64;
  display.requestedHeight = 32;
  display.refreshPointerStep();
  manager.bindDisplayContext({bitmap: allocateBurikoBitmap(64, 32, 1), bounds});
  const windows = new BurikoWindowDisplayState(manager);
  const created = manager.createConfigured(
    'window',
    (order) => new BurikoWindowDisplayObject(windows, order),
    (window) => window.configureInitial(32, 32),
  );
  assert.equal(created.result, 0);
  const window = manager.find('window', created.handle);
  window.setActivation(1);
  for (const [id, color] of [
    [0, 0xff0000],
    [1, 0x0000ff],
    [2, 0x202020],
    [3, 0x00ff00],
  ]) {
    assert.equal(surfaces.allocate(id, 4, 4, 1), 1);
    surfaces.fill(id, color);
  }
  let now = 100;
  const clock = new BurikoNativeClock(() => now),
    input = new BurikoNativeInput(display, clock),
    priorities = new BurikoProcedureState();
  input.foreground = true;
  input.pointerAvailable = true;
  input.pointerClientX = 3;
  input.pointerClientY = 4;
  input.resetCaptures();
  const cursor = new BurikoCursorPolicy(
    manager,
    input,
    clock,
    new BurikoNativeCursor({style: {cursor: ''}}),
  );
  const shared = new BurikoIndependentProcedures(manager),
    settings = new BurikoIndependentIconState();
  const errors = {
    files: {text},
    threadFatal() {
      assert.fail('ordinary IconEx fixture');
    },
  };
  const exSlots = createGroup91IndependentIconEx(
    shared,
    input,
    priorities,
    clock,
    cursor,
    settings,
    errors,
  );
  const slots = createGroup90IndependentIcons(shared, input, priorities, clock, cursor, settings, {
    files: {text},
    threadFatal() {
      assert.fail('ordinary Icon fixture');
    },
  });
  const thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    memory = new BurikoBpMemory(new Uint8Array(1024));
  const view = new DataView(memory.globalMemory.buffer),
    context = {thread, memory, diagnostics: {}};
  const words = (offset, values) =>
    values.forEach((v, i) => view.setInt32(offset + i * 4, v, true));
  const invoke = (primary, secondary, args) => {
    const slot = (primary === 0x91 ? exSlots : slots).find((s) => s.secondary === secondary);
    assert.deepEqual(
      [slot.primary, slot.nativeAddress],
      [primary, BURIKO_NATIVE_SLOT_ADDRESSES[primary][secondary]],
    );
    args.forEach((v) => push32(thread, v));
    assert.equal(slot.execute(context), 0);
    const result = pop32(thread);
    assert.equal(thread.stackIndex, 0);
    return result;
  };
  // VM group header, sixteen-DWORD group, and forty-nine-DWORD units.
  words(32, [1, 128, 0, 1, 0, 0, 0, 0, 0, 0]);
  words(128, [2, 2, 256, -1, 0, 1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0]);
  for (let i = 0; i < 2; i++) {
    const unit = new Array(49).fill(0);
    unit[0] = unit[1] = 1;
    unit[2] = i === 0 ? 2 : 10;
    unit[3] = 3;
    unit[4] = unit[5] = 1;
    unit[6] = i === 0 ? 2 : 1;
    unit[7] = i === 0 ? 10 : 0;
    unit[8] = i === 0 ? 0 : 2;
    unit[9] = -1;
    unit[10] = i === 0 ? -1 : 3;
    unit[11] = unit[12] = unit[44] = unit[47] = -1;
    words(256 + i * 196, unit);
  }
  const pixel = (x, y) => {
    const b = window.compositionBitmap;
    return bitmapRead32(b, b.offset + y * b.stride + x * 4) & 0xffffff;
  };
  const id = invoke(0x91, 0xb8, [created.handle]);
  assert.equal(id, 1);
  assert.equal(invoke(0x91, 0xba, [id, 32]), 0);
  assert.equal([...window.children()].length, 3);
  assert.deepEqual([pixel(2, 3), pixel(10, 3)], [0xff0000, 0x202020]);
  const actual = shared.find(id);
  assert.equal(await shared.pollEnabled(), 1);
  now = 111;
  assert.equal(await shared.pollEnabled(), 1);
  assert.equal(pixel(2, 3), 0x0000ff);
  assert.equal(actual.enqueue(Uint32Array.of(0x10000002, 0, 1)), 1);
  assert.equal(await shared.pollEnabled(), 1);
  assert.deepEqual([pixel(2, 3), pixel(10, 3)], [0x0000ff, 0x00ff00]);
  assert.equal(actual.enqueue(Uint32Array.of(0x10000007, 0, 1, 16, 3, 0)), 1);
  assert.equal(await shared.pollEnabled(), 1);
  assert.deepEqual([pixel(10, 3), pixel(16, 3)], [0, 0x00ff00]);
  assert.equal(invoke(0x90, 0xbe, [768, id]), 1);
  assert.equal(view.getInt32(768, true), 1);
  assert.equal(invoke(0x90, 0xb9, [id]), 1);
  assert.equal(window.getOwner(), null);
  assert.equal([...window.children()].length, 0);
});

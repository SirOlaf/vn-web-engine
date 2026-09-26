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
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';

test('independent Icon owns actual Window children, VM records, capture, selection and notification lifecycle', async () => {
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
    [0, 0x110000],
    [1, 0x002200],
    [2, 0x000033],
  ]) {
    assert.equal(surfaces.allocate(id, 3, 2, 1), 1);
    surfaces.fill(id, color);
  }
  const clock = new BurikoNativeClock(() => 100),
    input = new BurikoNativeInput(display, clock),
    priorities = new BurikoProcedureState();
  input.foreground = true;
  input.pointerAvailable = true;
  input.pointerClientX = 2;
  input.pointerClientY = 2;
  input.resetCaptures();
  const cursor = new BurikoCursorPolicy(
    manager,
    input,
    clock,
    new BurikoNativeCursor({style: {cursor: ''}}),
  );
  const shared = new BurikoIndependentProcedures(manager),
    settings = new BurikoIndependentIconState();
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
  const invoke = (secondary, args) => {
    const slot = slots.find((s) => s.secondary === secondary);
    assert.deepEqual(
      [slot.primary, slot.nativeAddress],
      [0x90, BURIKO_NATIVE_SLOT_ADDRESSES[0x90][secondary]],
    );
    args.forEach((v) => push32(thread, v));
    assert.equal(slot.execute(context), 0);
    const result = pop32(thread);
    assert.equal(thread.stackIndex, 0);
    return result;
  };
  // Header32, row52 and icon60 are VM layouts; native copies expand their pointer fields.
  words(32, [1, 128, 0, 1, 0, 0, 0, 0]);
  words(128, [2, 256, 0, 1, 0, 0, -1, 0, 0, -1, 0, 0, -1]);
  for (const [i, x] of [
    [0, 2],
    [1, 8],
  ])
    words(256 + i * 60, [1, x, 2, 0, 1, 2, -1, 0, 0, -1, 0, 0, -1, 0, 0]);
  const pixel = (x, y) => {
    const b = window.textBitmap;
    return bitmapRead32(b, b.offset + y * b.stride + x * 4) & 0xffffff;
  };
  assert.equal(invoke(0xb6, [created.handle, 32]), 0);
  assert.deepEqual([pixel(2, 2), pixel(8, 2)], [0x002200, 0x110000]);
  const id = invoke(0xb8, [created.handle]);
  assert.equal(id, 1);
  assert.equal(window.getOwner(), shared.find(id));
  assert.equal([...window.children()].length, 1);
  assert.equal(invoke(0xba, [id, 32]), 0);
  assert.equal([...window.children()].length, 3);
  assert.deepEqual([pixel(2, 2), pixel(8, 2)], [0x002200, 0x110000]);
  const actual = shared.find(id);
  assert.equal(invoke(0xbc, [544, id]), 1);
  assert.deepEqual(
    Array.from({length: 6}, (_, i) => view.getInt32(544 + i * 4, true)),
    [1, 0, 0, 0, 0, 0],
  );
  assert.equal(actual.enqueue(Uint32Array.of(0x10000002, 0, 1)), 1);
  assert.equal(await shared.pollEnabled(), 1);
  // Selected bitmap wins over hover initially. After changing column, old hovered icon
  // uses its blue hover bitmap and the second icon uses the green selected bitmap.
  assert.deepEqual([pixel(2, 2), pixel(8, 2)], [0x000033, 0x002200]);
  assert.equal(invoke(0xbd, [512, id]), 1);
  assert.equal(view.getInt32(512, true), 0);
  assert.equal(invoke(0xbe, [516, id]), 1);
  assert.equal(view.getInt32(516, true), 1);
  assert.equal(invoke(0xbf, [528, id]), 1);
  assert.deepEqual(
    [0, 1, 2].map((i) => view.getUint32(528 + i * 4, true)),
    [0x10000002, 0, 1],
  );
  // Native 08F790 leaves its output scratch unwritten on a miss. 08F990 still
  // copies it when the pressed hover changes, so leaving an icon must not fault.
  input.pointerClientX = 40;
  input.pointerClientY = 20;
  assert.equal(await shared.pollEnabled(), 1);
  assert.equal(actual.pressedHover, -1);
  assert.equal(actual.relative, undefined);
  assert.equal(actual.enqueue(Uint32Array.of(0x10000000, 1, 0)), 1);
  assert.equal(await shared.pollEnabled(), 1);
  assert.equal(invoke(0xbc, [544, id]), 1);
  assert.deepEqual(
    Array.from({length: 6}, (_, i) => view.getInt32(544 + i * 4, true)),
    [0, 0, 1, 0, 0, 0],
  );
  assert.equal(invoke(0xb9, [id]), 1);
  assert.equal(shared.find(id), null);
  assert.equal(window.getOwner(), null);
  assert.equal([...window.children()].length, 0);
  assert.equal(shared.registrationCount, 1);
  assert.deepEqual(
    input.captureDiagnosticView().pointer.map((n) => n.token),
    [1],
  );
  assert.deepEqual(
    input.captureDiagnosticView().key.map((n) => n.token),
    [1],
  );
});

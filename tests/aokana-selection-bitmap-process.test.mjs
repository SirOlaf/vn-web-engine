import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, push32, pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {allocateAokanaBitmap} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {bitmapRead32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {AokanaDisplayManager} from '../dist/engines/buriko/games/aokana/native/display-manager.js';
import {AokanaDisplayObjectEnvironment} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {AokanaWindowDisplayObject} from '../dist/engines/buriko/games/aokana/native/display-window.js';
import {AokanaWindowDisplayState} from '../dist/engines/buriko/games/aokana/native/display-window-state.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {AokanaNativeInput} from '../dist/engines/buriko/games/aokana/native/input.js';
import {AokanaProcedureState} from '../dist/engines/buriko/games/aokana/native/procedure.js';
import {AokanaIndependentIconState} from '../dist/engines/buriko/games/aokana/native/independent-icon.js';
import {createGroup90SelectionBitmapProcess} from '../dist/engines/buriko/games/aokana/native/group-90-selection-bitmap-process.js';
import {AokanaBitmapSelectionState} from '../dist/engines/buriko/games/aokana/native/selection-bitmap-state.js';
import {AokanaSelectionState} from '../dist/engines/buriko/games/aokana/native/selection-state.js';
import {AokanaWindowMessages} from '../dist/engines/buriko/games/aokana/native/procedure.js';
import {AokanaNativeNotifications} from '../dist/engines/buriko/games/aokana/native/notification-queue.js';
import {AokanaBpScheduler} from '../dist/engines/buriko/games/aokana/bp/scheduler.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';

function fixture() {
  const text = new AokanaNativeText(),
    compositor = new AokanaBitmapCompositor();
  compositor.defaultFormat = 1;
  const surfaces = new AokanaSurfaces(
    new AokanaNativeFonts(text),
    compositor,
    new AokanaDistributedAllocator(1),
  );
  const bounds = {left: 0, top: 0, right: 63, bottom: 31},
    environment = new AokanaDisplayObjectEnvironment(
      compositor,
      new AokanaDisplayDamage(128, bounds),
    );
  const display = new AokanaNativeDisplayState(64, 32),
    manager = new AokanaDisplayManager(environment, surfaces, display);
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
  window.setActivation(1);
  for (const [id, color] of [
    [0, 0xff0000],
    [1, 0x00ff00],
    [2, 0x0000ff],
    [3, 0x808080],
  ]) {
    assert.equal(surfaces.allocate(id, 4, 4, 1), 1);
    surfaces.fill(id, color);
  }

  window.setLayer(3);
  const clock = new AokanaNativeClock(() => 100),
    input = new AokanaNativeInput(display, clock);
  input.foreground = true;
  input.pointerAvailable = true;
  input.pointerClientX = 3;
  input.pointerClientY = 4;
  input.resetCaptures();
  const procedures = new AokanaProcedureState(),
    waits = new AokanaWindowMessages(),
    notifications = new AokanaNativeNotifications(),
    settings = new AokanaBitmapSelectionState(),
    textSettings = new AokanaSelectionState(),
    iconSettings = new AokanaIndependentIconState();
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 32,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const scheduler = new AokanaBpScheduler(
      new AokanaBpThread({id: 0, operandCapacity: 0, moduleCapacity: 0, frameCapacity: 0}),
      () => 0,
    ),
    node = scheduler.append(thread);
  const memory = new AokanaBpMemory(new Uint8Array(1024)),
    view = new DataView(memory.globalMemory.buffer);
  const slots = createGroup90SelectionBitmapProcess(
    manager,
    scheduler,
    procedures,
    clock,
    input,
    waits,
    notifications,
    settings,
    textSettings,
    iconSettings,
    {
      files: {text},
      threadFatal() {
        assert.fail('ordinary scheduled bitmap selection');
      },
    },
  );
  const words = (offset, values) =>
    values.forEach((value, i) => view.setInt32(offset + i * 4, value, true));
  const call = async (secondary, args, result = 0) => {
    const slot = slots.find((s) => s.secondary === secondary);
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x90][secondary]);
    args.forEach((value) => push32(thread, value));
    assert.equal(await slot.execute({thread, memory, diagnostics: {}}), result);
    assert.equal(thread.stackIndex, 0);
  };
  const pixel = (x, y) => {
    const b = window.compositionBitmap;
    return bitmapRead32(b, b.offset + y * b.stride + x * 4) & 0xffffff;
  };
  return {
    window,
    created,
    input,
    procedures,
    waits,
    notifications,
    settings,
    textSettings,
    iconSettings,
    thread,
    node,
    words,
    call,
    pixel,
  };
}

test('scheduled bitmap selection shares AF foreground state and returns actual pointer selection through scheduler', async () => {
  const f = fixture();
  f.words(32, [2, 3, 0, 1, 10, 3, 2, 3]);
  await f.call(0xaf, [1]);
  assert.deepEqual(
    [f.settings.foregroundOnly, f.textSettings.foregroundOnly, f.iconSettings.foregroundOnly],
    [1, 1, 1],
  );
  f.input.foreground = false;
  await f.call(0xb0, [f.created.handle, 2, 32, 0, 3, 1, 0], 2);
  assert.equal([...f.window.children()].length, 2);
  assert.equal(await f.node.pollProcess(false), 0);
  assert.equal(f.pixel(2, 3), 0xff0000);
  // AF changes the live eligibility gate; without a mouse event the next poll
  // observes the transition and renders the first icon's green highlight.
  await f.call(0xaf, [0]);
  assert.deepEqual(
    [f.settings.foregroundOnly, f.textSettings.foregroundOnly, f.iconSettings.foregroundOnly],
    [0, 0, 0],
  );
  assert.equal(await f.node.pollProcess(false), 0);
  assert.equal(f.pixel(2, 3), 0x00ff00);
  assert.deepEqual(f.notifications.take(), {type: 0x20000001, value1: 1, value2: 0x10000});
  f.input.foreground = true;
  await f.call(0xaf, [1]);
  f.input.pointerClientX = 11;
  f.input.pointerClientY = 4;
  f.waits.dispatch(0x200, 0n, 0n);
  assert.equal(await f.node.pollProcess(false), 0);
  assert.deepEqual([f.pixel(2, 3), f.pixel(10, 3)], [0xff0000, 0x808080]);
  assert.deepEqual(f.notifications.take(), {type: 0x20000001, value1: 1, value2: 0x10001});
  f.input.recordKeyDown(1);
  assert.equal(await f.node.pollProcess(false), 1);
  assert.deepEqual([pop32(f.thread), pop32(f.thread), pop32(f.thread)], [1, 1, 1]);
  assert.equal(f.thread.stackIndex, 0);
  assert.equal([...f.window.children()].length, 0);
  assert.equal(f.waits.consume(f.thread, 0x200), null);
  assert.equal(f.input.keyCaptureAllowed(1), true);
  assert.equal(f.procedures.pointerPriorityAllowed(f.window.sortKey() - 1), true);
});

test('extended scheduled bitmap selection renders all eight contiguous overlay triples and finishes a mapped key', async () => {
  const f = fixture();
  // The first icon's eight triples span both copied64-byte records. Only the
  // first overlay is present; later source IDs are ordinary absent overlays.
  const first = [2, 3, 0, 4, 5, 1, 0, 0, -1, 0, 0, -1, 0, 0, -1, -1];
  const second = [20, 16, 2, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, 0, 0, -1];
  f.words(32, [...first, ...second]);
  f.words(256, [0xc1, 0xc2]);
  await f.call(0xb1, [f.created.handle, 2, 32, 256, 3, 1, 0], 2);
  assert.equal(await f.node.pollProcess(false), 0);
  assert.deepEqual(f.window.overlayRectangle(0), {left: 4, top: 5, right: 7, bottom: 8});
  assert.equal(f.pixel(4, 5), 0x00ff00);
  for (let i = 1; i < 8; i++) assert.equal(f.window.overlayRectangle(i), null);
  assert.deepEqual(f.notifications.take(), {type: 0x20000001, value1: 1, value2: 0x10000});
  f.input.recordKeyDown(13);
  assert.equal(await f.node.pollProcess(false), 1);
  assert.deepEqual([pop32(f.thread), pop32(f.thread), pop32(f.thread)], [0, 0, 0]);
  assert.equal(f.thread.stackIndex, 0);
  assert.equal([...f.window.children()].length, 0);
  assert.equal(f.waits.consume(f.thread, 0x200), null);
  assert.equal(f.input.keyCaptureAllowed(1), true);
});

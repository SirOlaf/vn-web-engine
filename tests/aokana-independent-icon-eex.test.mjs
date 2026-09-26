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
import {AokanaNativeCursor} from '../dist/engines/buriko/games/aokana/native/engine-dialogs.js';
import {AokanaCursorPolicy} from '../dist/engines/buriko/games/aokana/native/cursor-policy.js';
import {AokanaProcedureState} from '../dist/engines/buriko/games/aokana/native/procedure.js';
import {AokanaIndependentProcedures} from '../dist/engines/buriko/games/aokana/native/independent-procedure.js';
import {AokanaIndependentIconState} from '../dist/engines/buriko/games/aokana/native/independent-icon.js';
import {createGroup90IndependentIcons} from '../dist/engines/buriko/games/aokana/native/group-90-independent-icons.js';
import {createGroup91IndependentIconEx} from '../dist/engines/buriko/games/aokana/native/group-91-independent-icon-ex.js';
import {createGroup91IndependentIconMotion} from '../dist/engines/buriko/games/aokana/native/group-91-independent-icon-motion.js';
import {AokanaNativeSplines} from '../dist/engines/buriko/games/aokana/native/spline-registry.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';

test('IconEEx spline motion, visibility and custom input map drive actual Window owners', async () => {
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
    [1, 0x0000ff],
    [2, 0x202020],
    [3, 0x00ff00],
  ]) {
    assert.equal(surfaces.allocate(id, 4, 4, 1), 1);
    surfaces.fill(id, color);
  }
  let now = 100;
  const clock = new AokanaNativeClock(() => now),
    input = new AokanaNativeInput(display, clock),
    priorities = new AokanaProcedureState();
  input.foreground = true;
  input.pointerAvailable = true;
  input.pointerClientX = 22;
  input.pointerClientY = 4;
  input.resetCaptures();
  const cursor = new AokanaCursorPolicy(
    manager,
    input,
    clock,
    new AokanaNativeCursor({style: {cursor: ''}}),
  );
  const shared = new AokanaIndependentProcedures(manager),
    settings = new AokanaIndependentIconState();
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
  const motionSlots = createGroup91IndependentIconMotion(
    shared,
    input,
    priorities,
    clock,
    cursor,
    settings,
    new AokanaNativeSplines(),
    errors,
  );
  const thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    memory = new AokanaBpMemory(new Uint8Array(1024));
  const view = new DataView(memory.globalMemory.buffer),
    context = {thread, memory, diagnostics: {}};
  const words = (offset, values) =>
    values.forEach((v, i) => view.setInt32(offset + i * 4, v, true));
  const invoke = (primary, secondary, args, pushed = true) => {
    const slot = (primary === 0x91 ? [...exSlots, ...motionSlots] : slots).find(
      (s) => s.secondary === secondary,
    );
    assert.deepEqual(
      [slot.primary, slot.nativeAddress],
      [primary, AOKANA_NATIVE_SLOT_ADDRESSES[primary][secondary]],
    );
    args.forEach((v) => push32(thread, v));
    assert.equal(slot.execute(context), 0);
    const result = pushed ? pop32(thread) : undefined;
    assert.equal(thread.stackIndex, 0);
    return result;
  };
  // VM group header, sixteen-DWORD group, and forty-nine-DWORD units.
  words(32, [1, 128, 0, 1, 0, 0, 4, 0, 0, 0]);
  words(128, [2, 2, 256, 0, 0, 1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0]);
  for (let i = 0; i < 2; i++) {
    const unit = new Array(49).fill(0);
    unit[0] = unit[1] = 1;
    unit[2] = i === 0 ? 2 : 20;
    unit[3] = 3;
    unit[4] = unit[5] = 1;
    unit[6] = 1;
    unit[7] = 0;
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
  const map = new Array(24).fill(0);
  map[12] = 6; // Native bit32768/right arrow uses custom "next column" action.
  words(800, map);
  assert.equal(invoke(0x91, 0xbf, [4, 800], false), undefined);
  const id = invoke(0x91, 0xbc, [created.handle]);
  assert.equal(id, 1);
  assert.equal(invoke(0x91, 0xba, [id, 32]), 0);
  const actual = shared.find(id);
  assert.equal(await shared.pollEnabled(), 1);
  assert.deepEqual([pixel(2, 3), pixel(20, 3)], [0xff0000, 0x202020]);
  words(672, [2, 3, 0, 0, 10, 3, 0, 0]);
  assert.equal(invoke(0x91, 0xbd, [id, 0, 0, 2, 672, 0, 0, 0, 0, 100, 1]), 0);
  assert.equal(actual.enqueue(Uint32Array.of(0x30000000, 0, 0, 0, 0)), 1);
  assert.equal(await shared.pollEnabled(), 1);
  now = 150;
  assert.equal(await shared.pollEnabled(), 1);
  // f32 reciprocal refinement at50/100 rounds toQ24 half; easing0 gives32768.
  // The real two-point spline therefore moves x2→10 to integerx6, y3,z0.
  assert.deepEqual([pixel(2, 3), pixel(6, 3)], [0, 0xff0000]);
  now = 200;
  assert.equal(await shared.pollEnabled(), 1);
  assert.deepEqual([pixel(6, 3), pixel(10, 3)], [0, 0xff0000]);
  assert.equal(invoke(0x91, 0xbb, [id, 0, 0, 0]), 0);
  assert.equal(pixel(10, 3), 0);
  assert.equal(invoke(0x91, 0xbb, [id, 0, 0, 1]), 0);
  assert.equal(pixel(10, 3), 0xff0000);
  input.recordKeyDown(39);
  assert.equal(await shared.pollEnabled(), 1);
  assert.equal(invoke(0x90, 0xbe, [768, id]), 1);
  assert.equal(view.getInt32(768, true), 1);
  assert.equal(pixel(20, 3), 0x00ff00);
  assert.equal(invoke(0x90, 0xb9, [id]), 1);
  assert.equal(window.getOwner(), null);
  assert.equal([...window.children()].length, 0);
});

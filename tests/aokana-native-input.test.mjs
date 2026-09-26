import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {BurikoNativeInput} from '../dist/engines/buriko/native/input.js';
import {BurikoNativeTouch} from '../dist/engines/buriko/native/touch-input.js';
import {
  createGroup80Input,
  createGroup81Input,
} from '../dist/engines/buriko/native/group-80-input.js';
import {createGroup81Display} from '../dist/engines/buriko/native/group-81-display.js';
import {
  BurikoNativeLanguage,
  createGroup81Language,
  group81Constant,
} from '../dist/engines/buriko/native/group-81-language.js';
import {
  BurikoNativeCursorMotion,
  BurikoBrowserCursorPosition,
  createGroup80CursorMotion,
} from '../dist/engines/buriko/native/cursor-motion.js';
import {nativeCursorInterpolation} from '../dist/engines/buriko/bp/opcodes/native-math.js';

function fixture() {
  let now = 100;
  const clock = new BurikoNativeClock(() => now);
  const display = new BurikoNativeDisplayState(1920, 1080);
  display.requestedWidth = 800;
  display.requestedHeight = 600;
  const input = new BurikoNativeInput(display, clock);
  input.foreground = true;
  input.inputActive = true;
  input.pointerAvailable = true;
  return {
    input,
    display,
    clock,
    advance(value) {
      now = value;
    },
  };
}

test('native key events distinguish held consumption, keyboard repeats and mouse repeats', () => {
  const {input, advance} = fixture();
  input.setPhysicalKey(13, true);
  assert.equal(input.recordKeyDown(13), true);
  assert.equal(input.recordKeyDown(13), false);
  assert.equal(input.consumeKey(13), 0x80000001);
  assert.equal(input.consumeKey(13), 0);
  assert.equal(input.totalPresses(13), 1);
  advance(599);
  assert.equal(input.repeatReady(13), false);
  advance(600);
  assert.equal(input.repeatReady(13), true);
  input.setPhysicalKey(1, true);
  input.recordKeyDown(1);
  assert.equal(input.consumeKey(1), 0x80000001);
  assert.equal(input.recordKeyDown(1), false);
  assert.equal(input.consumeKey(1), 0x80000001);
  input.setPhysicalKey(13, false);
  assert.equal(input.consumeKey(13), 0);
  assert.equal(input.repeatReady(13), false);
  input.exchangeKeyOption(13, 17);
  input.clearTransientKeys();
  assert.equal(input.totalPresses(13), 1);
  assert.equal(input.keyOption(13), 17);
  input.clearAllKeyRecords();
  assert.equal(input.totalPresses(13), 0);
  assert.equal(input.keyOption(13), 0);
});

test('async key queries consume the pressed bit before foreground filtering and map mouse buttons', () => {
  const {input} = fixture();
  input.foreground = false;
  input.setPhysicalKey(65, true);
  input.setPhysicalKey(65, false);
  assert.equal(input.queryKey(65), 0);
  input.foreground = true;
  assert.equal(input.queryKey(65), 0);
  input.setPhysicalKey(2, true);
  input.mouseButtonMode = 1;
  assert.equal(input.queryKey(1), 0x8001);
  assert.equal(input.queryKey(2), 0);
  input.systemMouseButtonsSwapped = true;
  assert.equal(input.queryKey(1), 0x8000);
  assert.equal(input.queryKey(2), 0);
  input.mouseButtonMode = 0;
  assert.equal(input.queryKey(1), 0x8000);
  assert.equal(input.queryKey(2), 0);
  input.setPhysicalKey(20, true);
  assert.equal(input.keyboardState[20], 0);
  input.setDequeuedKey(20, true);
  assert.equal(input.keyboardState[20], 0x81);
  input.setDequeuedKey(20, false);
  input.setDequeuedKey(20, true);
  assert.equal(input.keyboardState[20], 0x80);
});

test('capture sorting preserves duplicate order, object occlusion and separate key/pointer tokens', () => {
  const {input} = fixture();
  input.pointerClientX = 20;
  input.pointerClientY = 30;
  input.installPointerCapture(1);
  input.installKeyCapture(1);
  input.installObjectCapture(3, [0, 0, 100, 100], null);
  assert.equal(input.pointerCaptureAllowed(1), false);
  assert.equal(input.pointerCaptureAllowed(3), true);
  input.installObjectCapture(3, [200, 200, 300, 300], null);
  assert.equal(input.pointerCaptureAllowed(3), true);
  input.releasePointerCapture(3);
  assert.equal(input.pointerCaptureAllowed(1), false);
  input.releasePointerCapture(3);
  assert.equal(input.pointerCaptureAllowed(1), true);
  const calls = [];
  input.installObjectCapture(4, [0, 0, 0, 0], {
    inputActive() {
      calls.push('active');
      return 1;
    },
    inputRectangle(mode) {
      assert.equal(mode, 0);
      calls.push('rectangle');
      return [10, 20, 40, 50];
    },
    inputHitTest(x, y, mode) {
      assert.deepEqual([x, y, mode], [10, 10, 1]);
      calls.push('hit');
      return 0;
    },
  });
  assert.equal(input.pointerCaptureAllowed(1), true);
  assert.deepEqual(calls, ['active', 'rectangle', 'hit']);
  input.installKeyCapture(5);
  input.setPhysicalKey(13, true);
  input.recordKeyDown(13);
  input.setPhysicalKey(1, true);
  input.recordKeyDown(1);
  assert.equal(input.collect(4, 1), 1);
  assert.equal(input.collect(5, 1), 0x100);
});

test('key remapping preserves native group polling order and skip release behavior', () => {
  const {input} = fixture();
  input.installKeyCapture(1);
  input.installPointerCapture(1);
  assert.equal(input.replaceKeyGroup(0x100, [65, 66]), 0);
  assert.equal(input.replaceKeyGroup(0x200, [65]), 0);
  input.setPhysicalKey(65, true);
  input.recordKeyDown(65);
  input.setPhysicalKey(66, true);
  input.recordKeyDown(66);
  assert.equal(input.collect(1, 1), 0x100);
  assert.equal(input.consumeKey(0xc1), 0x80000001);
  assert.equal(input.replaceKeyGroup(7, Array(16).fill(13)), 0x80000002);
  assert.equal(input.replaceKeyGroup(7, []), 0x80000001);
  assert.equal(input.replaceKeyGroup(0x80000000, [17]), 0);
  input.setPhysicalKey(17, true);
  input.recordKeyDown(17);
  assert.equal(input.skipRequested(), true);
  input.armSkipRelease();
  assert.equal(input.skipRequested(), false);
  input.setPhysicalKey(17, false);
  input.recordKeyUp(17);
  assert.equal(input.skipRequested(), false);
  assert.equal(input.skipReleaseLatch, false);
  input.skipForced = 1;
  input.foreground = false;
  assert.equal(input.skipRequested(), true);
  input.skipAllowed = 0;
  assert.equal(input.skipRequested(), false);
});

test('native display conversion preserves fit, stretch, native size and desktop special cases', () => {
  const {display} = fixture();
  display.requestedWidth = 1600;
  display.requestedHeight = 900;
  assert.deepEqual(display.transformPoint(400, 300, 0), [800, 450]);
  assert.deepEqual(display.transformPoint(800, 450, 1), [400, 300]);
  display.fullscreen = 1;
  assert.deepEqual(display.transformPoint(100, 200, 0), [420, 360]);
  assert.deepEqual(display.transformPoint(420, 360, 1), [100, 200]);
  display.displayMode = 1;
  assert.deepEqual(display.transformPoint(400, 300, 0), [960, 540]);
  display.displayMode = 2;
  assert.deepEqual(display.transformPoint(0, 0, 0), [560, 240]);
  display.desktopWidth = 640;
  display.desktopHeight = 480;
  assert.equal(display.effectiveDisplayMode(), 0);
  display.desktopWidth = 3840;
  display.desktopHeight = 1080;
  assert.deepEqual(display.adjustedDesktopSize(), [1920, 1080]);
  display.desktopWidth = 1000;
  display.desktopHeight = 1100;
  assert.deepEqual(display.adjustedDesktopSize(), [1000, 550]);
  assert.equal(display.setSizePreset(16, 0, 0), 1);
  assert.equal(display.setSizePreset(15, 0, 1), 2);
  assert.equal(display.setSizePreset(15, -1, -2), 0);
  assert.equal(display.presetWidths[15], 0xffffffff);
  assert.equal(display.setAspectSize(1600, 1200), 0);
  assert.equal(display.setAspectSize(1600, 900), 0x80000008);
  assert.equal(display.setAspectSize(0, 0), 0);
  assert.deepEqual([display.aspectWidth, display.aspectHeight], [800, 600]);
});

test('native input slot pop order, capture flushing and click-index validation', () => {
  const {input} = fixture();
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 64,
    moduleCapacity: 64,
    frameCapacity: 64,
  });
  const bytes = new Uint8Array(1024),
    memory = new BurikoBpMemory(bytes),
    h = {thread, memory};
  const definitions = [...createGroup80Input(input), ...createGroup81Input(input)];
  const call = (primary, secondary, ...args) => {
    for (const arg of args) push32(thread, arg);
    return definitions.find((d) => d.primary === primary && d.secondary === secondary).execute(h);
  };
  input.setPhysicalKey(13, true);
  input.recordKeyDown(13);
  call(0x80, 0x18, 2);
  call(0x80, 0x1a, 2);
  assert.equal(pop32(thread), 0);
  input.setPhysicalKey(13, false);
  input.recordKeyUp(13);
  input.setPhysicalKey(13, true);
  input.recordKeyDown(13);
  call(0x80, 0x1a, 2);
  assert.equal(pop32(thread), 0x100);
  call(0x81, 0x10, 13, 0xabcdef);
  assert.equal(pop32(thread), 0);
  assert.equal(input.keyOption(13), 0xabcdef);
  call(0x81, 0x07, 0, 5);
  assert.equal(pop32(thread), 0);
  input.recordClickPosition(2, 40, 50);
  call(0x81, 0x07, 0x10, 2);
  assert.equal(pop32(thread), 1);
  assert.deepEqual([...new Int32Array(bytes.buffer, 16, 2)], [40, 50]);
  call(0x80, 0x10, 0);
  assert.equal(input.enabled, 0);
  assert.equal(input.totalPresses(13), 2);
  call(0x80, 0x1e, 7);
  assert.equal(pop32(thread), 0);
  assert.equal(input.mouseButtonMode, 0);
  call(0x80, 0x1e, 1);
  assert.equal(pop32(thread), 1);
  assert.equal(input.mouseButtonMode, 1);
});

test('native touch receiver retains two-pass order, metadata and distance-filtered history', () => {
  const {input, clock} = fixture();
  const calls = [];
  const touch = new BurikoNativeTouch(input, clock, {
    available: true,
    register(flags) {
      calls.push(['register', flags]);
      return 0;
    },
    unregister() {
      calls.push(['unregister']);
      return 1;
    },
    screenToClient(x, y) {
      return [x - 100, y - 200];
    },
  });
  const sample = (id, x, y, flags = 1) => ({
    id,
    x: (x + 100) * 100,
    y: (y + 200) * 100,
    flags,
    mask: 5,
    time: 1234,
    contactWidth: 1234,
    contactHeight: 567,
  });
  assert.equal(touch.configureHistory(513, 0), 0);
  assert.equal(touch.configureHistory(4, 5), 1);
  touch.receive([sample(2, 20, 30), sample(1, 0, 0, 0x12)]);
  assert.deepEqual(input.touchPositions, [
    [0, 0],
    [20, 30],
  ]);
  assert.equal(input.totalPresses(7), 1);
  const output = new Uint8Array(128),
    pointer = {bytes: output, offset: 0};
  assert.equal(touch.copyContacts(pointer), 2);
  assert.deepEqual(
    [...new Uint32Array(output.buffer, 0, 12)],
    [0, 0, 0, 12, 5, 1234, 1, 20, 30, 12, 5, 1234],
  );
  touch.receive([sample(1, 3, 0)]); // Below the five-pixel threshold.
  assert.equal(touch.copyHistory(null, null, 0, 1), 0);
  touch.receive([sample(1, 10, 0)]);
  touch.receive([sample(1, 20, 0)]);
  const angles = {bytes: output, offset: 80};
  assert.equal(touch.copyHistory(pointer, angles, 0, 9), 2);
  assert.deepEqual([...new Int32Array(output.buffer, 0, 4)], [10, 0, 0, 0]);
  assert.deepEqual([...new Uint32Array(output.buffer, 80, 2)], [0, 0xffffffff]);
  assert.equal(touch.setRegistration(1), 0);
  assert.deepEqual(calls, [['register', 1]]);
  assert.equal(touch.copyContacts(null), 0);
  assert.equal(touch.copyHistory(pointer, angles, 0, 9), 2); // Registration only clears contacts.
  touch.receive([sample(2, 0, 0, 4)]);
  assert.equal(touch.copyHistory(null, null, 0, 2), 0);
});

test('native cursor interpolation uses wrapped fixed products and motion cancellation after OS failure', () => {
  const {input, display, clock, advance} = fixture();
  clock.setGapLimit(1000);
  display.refreshPointerStep();
  assert.deepEqual([display.pointerStepX, display.pointerStepY], [65536, 65536]);
  const calls = [],
    motion = new BurikoNativeCursorMotion(input, clock, {
      setClientPosition(x, y) {
        calls.push([x, y]);
        return false;
      },
    });
  assert.equal(motion.start(400, 200, 0, 1000, 4, 0), true);
  advance(350);
  motion.advance();
  assert.deepEqual(calls, [[100, 50]]);
  advance(1100);
  motion.advance();
  assert.deepEqual(calls, [
    [100, 50],
    [200, 100],
    [300, 150],
    [400, 200],
  ]);
  assert.equal(motion.active, false);
  assert.deepEqual(input.pointerPosition(), [0, 0]);
  assert.equal(motion.start(400, 0, 0, 1000, 4, 1), true);
  advance(1350);
  motion.advance();
  advance(1600);
  motion.advance();
  assert.equal(motion.active, false);
  assert.deepEqual(calls.at(-1), [100, 0]);
  input.iconic = 1;
  assert.equal(motion.start(1, 2, 0, 0, 0, 0), false);
  input.iconic = 0;
  motion.start(1, 2, 0, 0, 0, 0);
  input.foreground = false;
  motion.advance();
  assert.equal(motion.active, false);
  assert.equal(new BurikoBrowserCursorPosition().setClientPosition(10, 20), false);
  assert.equal(nativeCursorInterpolation(100, 1, 1, 4), 14);
  assert.equal(nativeCursorInterpolation(-100, 1, 1, 4), -15);
  assert.equal(nativeCursorInterpolation(100, 1, 2, 4), 50);
  assert.equal(nativeCursorInterpolation(100000, 0, 1, 2), -15536);
});

test('display and language slot boundaries retain native pop order and Boolean/status distinctions', () => {
  const {input, display, clock, advance} = fixture();
  const bytes = new Uint8Array(64),
    thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 32,
      moduleCapacity: 64,
      frameCapacity: 64,
    });
  const memory = new BurikoBpMemory(bytes),
    language = new BurikoNativeLanguage(() => 0x409);
  const moved = [],
    motion = new BurikoNativeCursorMotion(input, clock, {
      setClientPosition(x, y) {
        moved.push([x, y]);
        return false;
      },
    });
  const definitions = [
    ...createGroup81Display(display),
    ...createGroup81Language(language),
    group81Constant,
    ...createGroup80CursorMotion(motion),
  ];
  const call = (primary, secondary, ...args) => {
    for (const arg of args) push32(thread, arg);
    return definitions
      .find((d) => d.primary === primary && d.secondary === secondary)
      .execute({thread, memory});
  };
  call(0x81, 0x60, 15, 1234, 567);
  assert.equal(pop32(thread), 0);
  assert.equal(display.presetWidths[15], 1234);
  assert.equal(display.presetHeights[15], 567);
  call(0x81, 0x6c, 800, 600);
  assert.equal(pop32(thread), 1);
  call(0x81, 0x6c, 800, 450);
  assert.equal(pop32(thread), 0);
  call(0x81, 0x63, 2);
  assert.equal(pop32(thread), 1);
  call(0x81, 0x63, 3);
  assert.equal(pop32(thread), 0);
  assert.equal(display.displayMode, 2);
  call(0x81, 0x02, 0);
  assert.equal(pop32(thread), 0x409);
  call(0x81, 0x01);
  assert.equal(pop32(thread), 0);
  call(0x81, 0x02, 0xffff0411);
  assert.equal(pop32(thread), 0xffff0411);
  call(0x81, 0x01);
  assert.equal(pop32(thread), 1);
  call(0x81, 0x03);
  assert.equal(pop32(thread), 0xffff0411);
  call(0x81, 0x6e);
  assert.equal(pop32(thread), 1);
  call(0x80, 0x1f, 100, 200, 0, 0, 0, 0);
  assert.equal(thread.stackIndex, 0);
  motion.advance();
  assert.deepEqual(moved, [[100, 200]]);
});

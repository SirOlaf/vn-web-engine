import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoNativeInput} from '../dist/engines/buriko/native/input.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {BurikoWindowMessages} from '../dist/engines/buriko/native/window-messages.js';
import {BurikoKeyboardMessages} from '../dist/engines/buriko/native/keyboard-messages.js';
import {
  BurikoFocusedHotkeyRegistration,
  BurikoPrintScreenHotkeys,
} from '../dist/engines/buriko/native/print-screen-hotkeys.js';
import {createGroup81Hotkeys} from '../dist/engines/buriko/native/group-81-hotkeys.js';
import {BurikoBpThread, push32} from '../dist/engines/buriko/bp/state.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';

function fixture() {
  const input = new BurikoNativeInput(
      new BurikoNativeDisplayState(1280, 720),
      new BurikoNativeClock(() => 10),
    ),
    messages = new BurikoWindowMessages(input),
    keyboard = new BurikoKeyboardMessages(messages),
    registration = new BurikoFocusedHotkeyRegistration(keyboard),
    calls = [];
  input.foreground = true;
  messages.createMainTarget();
  const hotkeys = new BurikoPrintScreenHotkeys(messages, {
    register(...args) {
      calls.push(['register', ...args]);
      return registration.register(...args);
    },
    unregister(...args) {
      calls.push(['unregister', ...args]);
      return registration.unregister(...args);
    },
  });
  const post = (code, keyCode, down = true, repeat = false, target = 'main') =>
    keyboard.post(target, {
      code,
      keyCode,
      type: down ? 'keydown' : 'keyup',
      repeat,
      getModifierState: () => false,
    });
  return {input, messages, keyboard, registration, calls, hotkeys, post};
}

test('81 69 registers and unregisters all sixteen modifiers in native order on the shared keyboard owner', () => {
  const s = fixture(),
    thread = new BurikoBpThread({id: 1, operandCapacity: 4, moduleCapacity: 0, frameCapacity: 0}),
    slots = createGroup81Hotkeys(s.hotkeys);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x81][0x69]);
  const call = (value) => {
    push32(thread, value);
    assert.equal(slots[0].execute({thread}), 0);
  };
  call(7);
  assert.deepEqual(
    s.calls,
    Array.from({length: 16}, (_, id) => ['register', 'main', id, id, 0x2c]),
  );
  call(1);
  assert.equal(s.calls.length, 16);
  const child = s.messages.createTarget();
  s.post('ControlLeft', 17);
  s.post('ShiftRight', 16);
  s.post('PrintScreen', 44, true, false, child);
  assert.equal(s.input.queryKey(44) & 0x8000, 0x8000);
  const hotkey = s.messages.take();
  assert.deepEqual(hotkey, {target: 'main', message: 0x312, wParam: 6, lParam: 0x002c0006});
  assert.equal(s.messages.isPhysical(hotkey), true);
  assert.deepEqual([s.messages.take().wParam, s.messages.take().wParam], [17, 16]);
  s.post('PrintScreen', 44, true, true, child);
  assert.equal(s.messages.take().message, 0x312);
  s.post('PrintScreen', 44, false, false, child);
  assert.equal(s.messages.take().message, 0x101);
  call(0);
  assert.deepEqual(
    s.calls.slice(16),
    Array.from({length: 16}, (_, id) => ['unregister', 'main', id]),
  );
  call(0);
  assert.equal(s.calls.length, 32);
  s.post('PrintScreen', 44, true, false, child);
  assert.equal(s.messages.take().message, 0x100);
  assert.equal(thread.stackIndex, 0);
});

test('FF470 keeps its native latch even when the selected host does not register a combination', () => {
  const s = fixture(),
    calls = [];
  const hotkeys = new BurikoPrintScreenHotkeys(s.messages, {
    register: (...args) => {
      calls.push(['register', ...args]);
      return false;
    },
    unregister: (...args) => {
      calls.push(['unregister', ...args]);
      return false;
    },
  });
  hotkeys.setEnabled(1);
  hotkeys.setEnabled(2);
  assert.equal(calls.length, 16);
  hotkeys.setEnabled(0);
  assert.equal(calls.length, 32);
  assert.deepEqual(
    calls.map((entry) => entry[2]),
    [...Array(16).keys(), ...Array(16).keys()],
  );
  assert.equal(s.registration.scope, 'focused-title-window');
  s.post('PrintScreen', 44);
  assert.equal(s.messages.take().message, 0x100);
});

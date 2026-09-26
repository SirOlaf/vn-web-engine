import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {BurikoNativeInput} from '../dist/engines/buriko/native/input.js';
import {BurikoKeyboardMessages} from '../dist/engines/buriko/native/keyboard-messages.js';
import {BurikoWindowMessages} from '../dist/engines/buriko/native/window-messages.js';

function fixture() {
  const input = new BurikoNativeInput(
      new BurikoNativeDisplayState(1920, 1080),
      new BurikoNativeClock(() => 10),
    ),
    messages = new BurikoWindowMessages(input),
    keyboard = new BurikoKeyboardMessages(messages);
  input.foreground = true;
  messages.createMainTarget();
  const key = (code, keyCode, type = 'keydown', altGraph = false) =>
    keyboard.post('main', {
      code,
      keyCode,
      type,
      repeat: false,
      getModifierState: (name) => name === 'AltGraph' && altGraph,
    });
  return {input, messages, keyboard, key};
}

test('deactivation clears async state immediately and dequeued state after older queued keydowns', () => {
  const {input, messages, keyboard, key} = fixture();
  input.exchangeKeyOption(65, 7);
  key('KeyA', 65);
  assert.equal(keyboard.isHeld('KeyA', 65), true);
  keyboard.deactivate();
  assert.equal(keyboard.isHeld('KeyA', 65), false);
  // The DOM bridge drops this later keyup instead of feeding an unmatched WM_KEYUP.
  if (keyboard.isHeld('KeyA', 65)) key('KeyA', 65, 'keyup');
  assert.equal(messages.pending, 2); // The original keydown and internal reset only.
  assert.equal(input.asynchronousKeyState(65), 0);
  assert.equal(input.keyboardState[65], 0);
  assert.equal(messages.take().message, 0x100);
  assert.equal(input.keyboardState[65], 0x80);
  input.recordKeyDown(65); // The older keydown's main receiver effect.
  assert.equal(messages.take(), null); // Internal reset, invisible to the receiver.
  assert.equal(input.keyboardState[65], 0);
  assert.equal(input.repeatReady(65), false);
  assert.equal(input.totalPresses(65), 1);
  assert.equal(input.keyOption(65), 7);
  assert.equal(input.consumeKey(65), 1); // Pending press is retained.
  key('KeyA', 65);
  assert.equal(messages.take().lParam & 0x40000000, 0); // Fresh keydown, not repeat.
});

test('deactivation releases both modifier sides and synthetic AltGraph control without keyup messages', () => {
  const {input, messages, keyboard, key} = fixture();
  key('ShiftLeft', 16);
  key('ShiftRight', 16);
  key('AltRight', 225, 'keydown', true);
  keyboard.deactivate();
  const observed = [];
  for (let message; (message = messages.take()) !== null;) observed.push(message.message);
  assert.deepEqual(observed, [0x100, 0x100, 0x100, 0x100]);
  for (const virtualKey of [0x10, 0xa0, 0xa1, 0x11, 0xa2, 0x12, 0xa5]) {
    assert.equal(input.keyboardState[virtualKey] & 0x80, 0);
    assert.equal(input.asynchronousKeyState(virtualKey), 0);
  }
  key('AltLeft', 18);
  assert.equal(messages.take().message, 0x104); // Alt menu state starts fresh.
});

test('a new keydown after deactivation remains physically held across the older reset marker', () => {
  const {input, messages, keyboard, key} = fixture();
  key('KeyA', 65);
  keyboard.deactivate();
  key('KeyA', 65);
  assert.equal(input.asynchronousKeyState(65) & 0x8000, 0x8000);
  assert.equal(messages.take().lParam & 0x40000000, 0);
  assert.equal(messages.take().lParam & 0x40000000, 0);
  assert.equal(input.keyboardState[65], 0x80);
  assert.equal(messages.take(), null);
});

test('reset markers stay invisible through posted, pump, paint and quit dequeue APIs', () => {
  const {input, messages} = fixture();
  input.setPhysicalKey(65, true);
  messages.post({target: 'main', message: 0x9001, wParam: 0, lParam: 0});
  messages.releasePhysicalKeys([65]);
  messages.post({target: 'main', message: 0x9002, wParam: 0, lParam: 0});
  assert.equal(messages.takePostedEvent().message.message, 0x9001);
  assert.equal(messages.takePostedEvent().message.message, 0x9002);
  assert.equal(messages.takePostedEvent(), null);
  messages.invalidate('main');
  messages.releasePhysicalKeys([65]);
  const pumpPaint = messages.takePumpEvent().message;
  assert.equal(pumpPaint.message, 0xf);
  messages.validatePaint(pumpPaint);
  messages.invalidate('main');
  messages.releasePhysicalKeys([65]);
  const directPaint = messages.take();
  assert.equal(directPaint.message, 0xf);
  messages.validatePaint(directPaint);
  input.setDequeuedKey(0x14, true);
  messages.releasePhysicalKeys([0x14]);
  assert.equal(messages.takePostedEvent(), null);
  assert.equal(input.keyboardState[0x14], 1); // CapsLock toggle survives deactivation.
  messages.postQuit(4);
  messages.releasePhysicalKeys([65]);
  assert.deepEqual(messages.takePostedEvent(), {kind: 'quit', exitCode: 4});
  assert.equal(messages.takePostedEvent(), null);
});

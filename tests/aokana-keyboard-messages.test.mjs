import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaNativeInput} from '../dist/engines/buriko/games/aokana/native/input.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {AokanaWindowMessages} from '../dist/engines/buriko/games/aokana/native/window-messages.js';
import {
  AokanaKeyboardMessages,
  aokanaWindowsScanCode,
} from '../dist/engines/buriko/games/aokana/native/keyboard-messages.js';
function setup() {
  const input = new AokanaNativeInput(
    new AokanaNativeDisplayState(1920, 1080),
    new AokanaNativeClock(() => 10),
  );
  input.foreground = true;
  const queue = new AokanaWindowMessages(input),
    keyboard = new AokanaKeyboardMessages(queue);
  const post = (code, keyCode, down = true, repeat = false, altGraph = false, target = 'main') =>
    keyboard.post(target, {
      code,
      keyCode,
      type: down ? 'keydown' : 'keyup',
      repeat,
      getModifierState: (name) => name === 'AltGraph' && altGraph,
    });
  return {input, queue, post};
}
test('keyboard translation preserves logical layout, physical scan, repeat flags and queued input timing', () => {
  const {input, queue, post} = setup();
  post('KeyY', 90); // German Z at the physical US-Y position.
  assert.equal(input.queryKey(90) & 0x8000, 0x8000);
  assert.equal(input.keyboardState[90], 0);
  assert.deepEqual(queue.take(), {target: 'main', message: 0x100, wParam: 90, lParam: 0x00150001});
  assert.equal(input.keyboardState[90], 0x80);
  post('KeyY', 90, true, true);
  post('KeyY', 90, false);
  assert.equal(queue.take().lParam, 0x40150001);
  assert.equal(queue.take().lParam, 0xc0150001);
  assert.equal(input.keyboardState[90], 0);
  assert.equal(queue.take(), null);
});
test('keyboard generic modifiers remain held when the opposite physical modifier is released', () => {
  const {input, queue, post} = setup();
  post('ShiftLeft', 16);
  post('ShiftRight', 16);
  post('ShiftLeft', 16, false);
  while (queue.take() !== null) {}
  assert.equal(input.keyboardState[16], 0x80);
  assert.equal(input.keyboardState[0xa0], 0);
  assert.equal(input.keyboardState[0xa1], 0x80);
  assert.equal(input.queryKey(16) & 0x8000, 0x8000);
  post('ShiftRight', 16, false);
  const event = queue.take();
  assert.equal(event.lParam, 0xc0360001);
  assert.equal(input.keyboardState[16], 0);
  post('NumpadEnter', 13);
  assert.equal(queue.take().lParam, 0x011c0001);
  assert.equal(aokanaWindowsScanCode('NumLock'), 0xe045);
});
test('Alt menu latch, Ctrl+Alt and F10 produce distinct native system-key sequences', () => {
  const s = setup();
  s.post('AltLeft', 18);
  s.post('AltLeft', 18, false);
  assert.deepEqual([s.queue.take().message, s.queue.take().message], [0x104, 0x105]);
  s.post('AltLeft', 18);
  s.post('KeyA', 65);
  s.post('KeyA', 65, false);
  s.post('AltLeft', 18, false);
  const messages = Array.from({length: 4}, () => s.queue.take());
  assert.deepEqual(
    messages.map((m) => m.message),
    [0x104, 0x104, 0x105, 0x101],
  );
  assert.deepEqual(
    messages.map((m) => (m.lParam & 0x20000000) !== 0),
    [true, true, true, false],
  );
  s.post('ControlLeft', 17);
  s.post('AltLeft', 18);
  s.post('KeyA', 65);
  assert.deepEqual(
    Array.from({length: 3}, () => s.queue.take().message),
    [0x100, 0x100, 0x100],
  );
  s.post('F10', 121);
  assert.equal(s.queue.take().message, 0x104);
});
test('AltGraph expands its missing Windows control transition and preserves child target identity', () => {
  const {input, queue, post} = setup(),
    child = queue.createTarget();
  post('AltRight', 225, true, false, true, child);
  post('AltRight', 225, false, false, false, child);
  const messages = Array.from({length: 4}, () => queue.take());
  assert.deepEqual(
    messages.map((m) => [m.target, m.message, m.wParam, m.lParam]),
    [
      [child, 0x100, 17, 0x001d0001],
      [child, 0x100, 18, 0x21380001],
      [child, 0x105, 17, 0xe01d0001],
      [child, 0x101, 18, 0xc1380001],
    ],
  );
  assert.equal(input.keyboardState[0xa2], 0);
  assert.equal(input.keyboardState[0xa5], 0);
});

test('dequeued browser key provenance remains distinct from synthetic posts and generated paint', () => {
  const {queue, post} = setup();
  const target = queue.createTarget();
  post('ArrowLeft', 37, true, false, false, target);
  const physical = queue.take();
  assert.equal(queue.isPhysical(physical), true);
  queue.post(physical);
  const synthetic = queue.take();
  assert.deepEqual(synthetic, physical);
  assert.equal(queue.isPhysical(synthetic), false);
  queue.enqueuePhysicalTransitions({target, message: 0x200, wParam: 0, lParam: 0}, []);
  assert.equal(queue.isPhysical(queue.take()), true);
  queue.invalidate(target);
  assert.equal(queue.isPhysical(queue.take()), false);
  assert.equal(queue.isPhysical(physical), true);
});

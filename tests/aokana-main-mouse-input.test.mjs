import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {BurikoNativeInput} from '../dist/engines/buriko/native/input.js';
import {BurikoWindowMessages} from '../dist/engines/buriko/native/window-messages.js';
import {BurikoMainMouseInput} from '../dist/engines/buriko/native/main-mouse-input.js';

class Element {
  constructor() {
    this.listeners = new Map();
    this.style = {};
  }
  addEventListener(name, listener) {
    const entries = this.listeners.get(name) ?? [];
    entries.push(listener);
    this.listeners.set(name, entries);
  }
  removeEventListener(name, listener) {
    this.listeners.set(
      name,
      (this.listeners.get(name) ?? []).filter((entry) => entry !== listener),
    );
  }
  fire(name, fields = {}) {
    const event = {
      type: name,
      target: this,
      button: 0,
      buttons: 0,
      detail: 1,
      clientX: 15,
      clientY: 25,
      shiftKey: false,
      ctrlKey: false,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...fields,
    };
    for (const listener of this.listeners.get(name) ?? []) listener(event);
    return event;
  }
}

function fixture(wheel = null) {
  const canvas = new Element(),
    parent = new Element(),
    document = new Element(),
    outside = new Element(),
    display = new BurikoNativeDisplayState(640, 480),
    input = new BurikoNativeInput(display, new BurikoNativeClock(() => 0)),
    messages = new BurikoWindowMessages(input);
  document.visibilityState = 'visible';
  messages.createMainTarget();
  const host = {
    surface: canvas,
    parent,
    document,
    display,
    callbacks: {isReady: () => true},
    focus: () => {
      document.activeElement = canvas;
    },
    mapCanvasViewportPoint: (x, y) => ({
      screenX: -100 + x * 2,
      screenY: 50 + y * 2,
      clientX: (x - 10) * 2,
      clientY: (y - 20) * 2,
    }),
  };
  const mouse = new BurikoMainMouseInput(host, input, messages, wheel);
  return {canvas, parent, document, outside, input, messages, mouse};
}

test('main canvas mouse routes chorded buttons with native coordinates and dequeue timing', () => {
  const s = fixture();
  assert.equal(s.canvas.fire('mousedown', {buttons: 1}).defaultPrevented, true);
  assert.equal(s.input.asynchronousKeyState(1) & 0x8000, 0x8000);
  assert.equal(s.input.keyboardState[1], 0);
  assert.deepEqual(s.input.screenCursorPosition(), [-70, 100]);
  assert.deepEqual([s.input.pointerClientX, s.input.pointerClientY], [10, 10]);
  assert.deepEqual(s.messages.take(), {
    target: 'main',
    message: 0x201,
    wParam: 1,
    lParam: 0x000a000a,
  });
  assert.equal(s.input.keyboardState[1], 0x80);
  s.canvas.fire('mousedown', {button: 2, buttons: 3, shiftKey: true});
  assert.deepEqual(s.messages.take(), {
    target: 'main',
    message: 0x204,
    wParam: 7,
    lParam: 0x000a000a,
  });
  assert.equal(s.input.keyboardState[2], 0x80);
  s.canvas.fire('mouseup', {button: 2, buttons: 1});
  assert.equal(s.input.asynchronousKeyState(2) & 0x8000, 0);
  assert.deepEqual(s.messages.take(), {
    target: 'main',
    message: 0x205,
    wParam: 1,
    lParam: 0x000a000a,
  });
  s.canvas.fire('mouseup', {button: 0, buttons: 0});
  assert.equal(s.messages.take()?.message, 0x202);
  assert.equal(s.document.listeners.get('mousemove').length, 1);
  s.mouse.dispose();
  assert.equal(s.document.listeners.get('mousemove').length, 0);
});

test('double click and adjacent motion preserve message identity and bounded FIFO', () => {
  const s = fixture();
  s.canvas.fire('mousedown', {buttons: 1, detail: 1});
  s.canvas.fire('mouseup', {buttons: 0});
  s.canvas.fire('mousedown', {buttons: 1, detail: 2});
  s.canvas.fire('mouseup', {buttons: 0});
  assert.deepEqual(
    Array.from({length: 4}, () => s.messages.take()?.message),
    [0x201, 0x202, 0x203, 0x202],
  );
  s.canvas.fire('mousemove', {clientX: 16, buttons: 0});
  s.canvas.fire('mousemove', {clientX: 17, buttons: 0});
  assert.equal(s.messages.pending, 1);
  assert.equal(s.messages.take()?.lParam, 0x000a000e);
  s.canvas.fire('mousemove', {clientX: 18, buttons: 0});
  s.canvas.fire('mousedown', {buttons: 1});
  s.canvas.fire('mousemove', {clientX: 19, buttons: 1});
  assert.deepEqual(
    Array.from({length: 3}, () => s.messages.take()?.message),
    [0x200, 0x201, 0x200],
  );
  s.mouse.dispose();
});

test('middle and X buttons carry distinct native key and high-word identities', () => {
  const s = fixture();
  s.canvas.fire('mousedown', {button: 1, buttons: 4, clientX: 5, clientY: 15});
  assert.deepEqual(s.messages.take(), {
    target: 'main',
    message: 0x207,
    wParam: 0x10,
    lParam: 0xfff6fff6,
  });
  s.canvas.fire('mouseup', {button: 1, buttons: 0});
  assert.equal(s.messages.take()?.message, 0x208);
  s.canvas.fire('mousedown', {button: 3, buttons: 8});
  assert.deepEqual(s.messages.take(), {
    target: 'main',
    message: 0x20b,
    wParam: 0x10020,
    lParam: 0x000a000a,
  });
  assert.equal(s.input.asynchronousKeyState(5) & 0x8000, 0x8000);
  s.canvas.fire('mouseup', {button: 3, buttons: 0});
  assert.equal(s.messages.take()?.wParam, 0x10000);
  s.mouse.dispose();
});

test('drag-in and outside release update physical state without inventing main button messages', () => {
  const s = fixture();
  s.canvas.fire('mousemove', {buttons: 1});
  assert.equal(s.input.asynchronousKeyState(1) & 0x8000, 0x8000);
  assert.equal(s.messages.take()?.message, 0x200);
  assert.equal(s.messages.take(), null);
  s.canvas.fire('mouseup', {buttons: 0});
  assert.equal(s.messages.take()?.message, 0x202);
  s.canvas.fire('mousedown', {buttons: 1});
  assert.equal(s.document.listeners.get('mouseup').length, 1);
  s.document.fire('mouseup', {target: s.outside, button: 0, buttons: 0});
  assert.equal(s.input.asynchronousKeyState(1) & 0x8000, 0);
  assert.equal(s.messages.take()?.message, 0x201);
  assert.equal(s.messages.take(), null);
  assert.equal(s.input.keyboardState[1] & 0x80, 0);
  assert.equal(s.document.listeners.get('mouseup').length, 0);
  s.mouse.dispose();
});

test('drag-in release and outside hover update physical state without captured HWND messages', () => {
  const s = fixture();
  s.canvas.fire('mousemove', {buttons: 1});
  assert.equal(s.document.listeners.get('mouseup').length, 1);
  s.document.fire('mouseup', {target: s.outside, buttons: 0, clientX: 30, clientY: 40});
  assert.equal(s.input.asynchronousKeyState(1) & 0x8000, 0);
  assert.deepEqual([s.input.pointerClientX, s.input.pointerClientY], [40, 40]);
  assert.equal(s.messages.take()?.message, 0x200);
  assert.equal(s.messages.take(), null);
  s.canvas.fire('mouseleave', {clientX: 20, clientY: 30});
  assert.deepEqual([s.input.pointerClientX, s.input.pointerClientY], [20, 20]);
  s.document.fire('mousemove', {target: s.outside, clientX: 40, clientY: 50});
  assert.deepEqual([s.input.pointerClientX, s.input.pointerClientY], [60, 60]);
  assert.equal(s.messages.take(), null);
  s.mouse.dispose();
});

test('loss of host observation and disposal release buttons and remove listeners', () => {
  const s = fixture();
  s.canvas.fire('mousedown', {buttons: 1});
  s.document.fire('mouseleave', {target: s.document});
  assert.equal(s.input.asynchronousKeyState(1) & 0x8000, 0);
  assert.equal(s.document.listeners.get('mouseup').length, 0);
  assert.equal(s.messages.take()?.message, 0x201);
  assert.equal(s.messages.take(), null);
  s.canvas.fire('mousedown', {buttons: 1});
  s.mouse.dispose();
  assert.equal(s.input.asynchronousKeyState(1) & 0x8000, 0);
  assert.equal(s.canvas.listeners.get('mousedown').length, 0);
  assert.equal(s.document.listeners.get('mouseup').length, 0);
  assert.equal(s.messages.take()?.message, 0x201);
  assert.equal(s.messages.take(), null);
});

test('selected wheel conversion posts signed deltas with screen coordinates and fractional accumulation', () => {
  let vertical = 0;
  const s = fixture({
    translate(event) {
      vertical -= event.deltaY;
      const result = [];
      if (Math.abs(vertical) >= 100) {
        const sign = Math.sign(vertical);
        result.push({axis: 'vertical', delta: sign * 120});
        vertical -= sign * 100;
      }
      if (event.deltaX !== 0)
        result.push({axis: 'horizontal', delta: Math.sign(event.deltaX) * 120});
      return result;
    },
  });
  assert.equal(s.canvas.fire('wheel', {deltaY: 40, deltaX: 0}).defaultPrevented, true);
  assert.deepEqual(s.input.screenCursorPosition(), [-70, 100]);
  assert.equal(s.messages.take(), null);
  assert.equal(
    s.canvas.fire('wheel', {deltaY: 60, deltaX: 3, buttons: 1, shiftKey: true}).defaultPrevented,
    true,
  );
  assert.equal(s.input.asynchronousKeyState(1) & 0x8000, 0x8000);
  assert.deepEqual(s.messages.take(), {
    target: 'main',
    message: 0x20a,
    wParam: 0xff880005,
    lParam: 0x0064ffba,
  });
  assert.deepEqual(s.messages.take(), {
    target: 'main',
    message: 0x20e,
    wParam: 0x00780005,
    lParam: 0x0064ffba,
  });
  assert.equal(s.messages.take(), null);
  s.document.fire('mouseup', {target: s.outside, buttons: 0});
  assert.equal(s.input.asynchronousKeyState(1) & 0x8000, 0);
  assert.equal(s.messages.take(), null);
  s.mouse.dispose();
  assert.equal(s.canvas.listeners.get('wheel').length, 0);
});

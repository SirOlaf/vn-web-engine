import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {BurikoNativeInput} from '../dist/engines/buriko/native/input.js';
import {BurikoWindowMessages} from '../dist/engines/buriko/native/window-messages.js';
import {BurikoKeyboardMessages} from '../dist/engines/buriko/native/keyboard-messages.js';
import {BurikoMainDomInput} from '../dist/engines/buriko/native/main-dom-input.js';

class Element {
  constructor(parent = null) {
    this.parent = parent;
    this.listeners = new Map();
    this.tabIndex = -1;
  }
  contains(target) {
    for (let at = target; at !== null; at = at.parent) if (at === this) return true;
    return false;
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((saved) => saved !== listener),
    );
  }
  fire(type, fields = {}) {
    const event = {
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...fields,
    };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }
}

function fixture() {
  const parent = new Element(),
    canvas = new Element(parent),
    child = new Element(parent),
    outside = new Element(),
    document = new Element();
  document.activeElement = canvas;
  document.visibilityState = 'visible';
  document.focused = true;
  document.hasFocus = () => document.focused;
  document.defaultView = new Element();
  const display = new BurikoNativeDisplayState(640, 480),
    input = new BurikoNativeInput(display, new BurikoNativeClock(() => 0)),
    messages = new BurikoWindowMessages(input),
    keyboard = new BurikoKeyboardMessages(messages);
  messages.createMainTarget();
  const host = {
    document,
    parent,
    surface: canvas,
    display,
    isForegroundWindow: () =>
      document.focused &&
      document.visibilityState !== 'hidden' &&
      parent.contains(document.activeElement),
  };
  const ingress = new BurikoMainDomInput(host, input, messages, keyboard);
  const key = (code, keyCode, type = 'keydown') => {
    return canvas.fire(type, {code, keyCode, repeat: false, getModifierState: () => false});
  };
  return {parent, canvas, child, outside, document, input, messages, keyboard, ingress, key};
}

test('main canvas keyboard ingress owns focusable surface, shared FIFO and scoped release', async () => {
  const s = fixture();
  assert.equal(s.canvas.tabIndex, 0);
  assert.equal(s.input.foreground, true);
  assert.equal(s.key('KeyA', 65).defaultPrevented, true);
  assert.equal(s.input.asynchronousKeyState(65) & 0x8000, 0x8000);
  assert.deepEqual(s.messages.take(), {
    target: 'main',
    message: 0x100,
    wParam: 65,
    lParam: 0x1e0001,
  });
  s.document.activeElement = s.child;
  s.parent.fire('focusout', {relatedTarget: s.child});
  await Promise.resolve();
  assert.equal(s.input.foreground, true);
  assert.equal(s.input.asynchronousKeyState(65) & 0x8000, 0x8000);
  s.document.activeElement = s.canvas;
  s.key('KeyA', 65, 'keyup');
  assert.equal(s.messages.take()?.message, 0x101);

  s.key('KeyB', 66);
  s.document.activeElement = s.outside;
  s.parent.fire('focusout', {relatedTarget: s.outside});
  await Promise.resolve();
  assert.equal(s.input.foreground, false);
  assert.equal(s.input.asynchronousKeyState(66) & 0x8000, 0);
  assert.equal(s.messages.take()?.wParam, 66);
  assert.equal(s.messages.take(), null);
  s.key('KeyC', 67);
  assert.equal(s.messages.take(), null);
  assert.equal(s.key('KeyC', 67).defaultPrevented, false);
  s.document.activeElement = s.canvas;
  s.parent.fire('focusin');
  assert.equal(s.key('KeyB', 66, 'keyup').defaultPrevented, false);
  assert.equal(s.messages.take(), null);
  s.ingress.dispose();
  s.ingress.dispose();
  assert.equal(s.canvas.tabIndex, -1);
  assert.equal(s.canvas.listeners.get('keydown').length, 0);
});

test('document visibility loss releases held keys without posting a native message', () => {
  const s = fixture();
  s.key('ControlLeft', 17);
  s.document.visibilityState = 'hidden';
  s.document.fire('visibilitychange');
  assert.equal(s.input.foreground, false);
  assert.equal(s.input.asynchronousKeyState(0x11) & 0x8000, 0);
  assert.equal(s.messages.take()?.message, 0x100);
  assert.equal(s.messages.take(), null);
  s.document.visibilityState = 'visible';
  s.document.fire('visibilitychange');
  assert.equal(s.input.foreground, true);
  s.document.focused = false;
  s.document.defaultView.fire('blur');
  assert.equal(s.input.foreground, false);
  s.document.focused = true;
  s.document.defaultView.fire('focus');
  assert.equal(s.input.foreground, true);
  s.ingress.dispose();
});

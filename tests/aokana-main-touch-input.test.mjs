import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {BurikoNativeInput} from '../dist/engines/buriko/native/input.js';
import {BurikoNativeTouch} from '../dist/engines/buriko/native/touch-input.js';
import {BurikoWindowMessages} from '../dist/engines/buriko/native/window-messages.js';
import {BurikoMainWindowMessageReceiver} from '../dist/engines/buriko/native/main-window-messages.js';
import {
  BurikoBrowserTouchWindow,
  BurikoMainTouchInput,
} from '../dist/engines/buriko/native/main-touch-input.js';
import {BurikoMainMouseInput} from '../dist/engines/buriko/native/main-mouse-input.js';

class Element {
  constructor() {
    this.listeners = new Map();
    this.style = {touchAction: 'pan-x', visibility: 'visible'};
    this.captured = new Set();
  }
  addEventListener(name, listener) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  removeEventListener(name, listener) {
    this.listeners.set(
      name,
      (this.listeners.get(name) ?? []).filter((entry) => entry !== listener),
    );
  }
  setPointerCapture(id) {
    this.captured.add(id);
  }
  hasPointerCapture(id) {
    return this.captured.has(id);
  }
  releasePointerCapture(id) {
    this.captured.delete(id);
  }
  fire(name, fields = {}) {
    const event = {
      type: name,
      target: this,
      pointerType: 'touch',
      pointerId: 1,
      isPrimary: true,
      clientX: 15,
      clientY: 25,
      width: 3,
      height: 5,
      timeStamp: 123,
      button: 0,
      buttons: 0,
      detail: 1,
      shiftKey: false,
      ctrlKey: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...fields,
    };
    for (const listener of this.listeners.get(name) ?? []) listener(event);
    return event;
  }
}

function fixture(available = true) {
  const canvas = new Element(),
    parent = new Element(),
    document = new Element();
  document.visibilityState = 'visible';
  const display = new BurikoNativeDisplayState(640, 480),
    input = new BurikoNativeInput(display, new BurikoNativeClock(() => 77)),
    messages = new BurikoWindowMessages(input);
  messages.createMainTarget();
  const host = {
    surface: canvas,
    parent,
    document,
    display,
    callbacks: {isReady: () => true},
    isLiveMainWindow: () => true,
    focusCalls: 0,
    focus() {
      this.focusCalls++;
      input.foreground = true;
    },
    mapCanvasViewportPoint(x, y) {
      return {
        screenX: -100 + x * 2,
        screenY: 50 + y * 2,
        clientX: (x - 10) * 2,
        clientY: (y - 20) * 2,
      };
    },
  };
  const touchWindow = new BurikoBrowserTouchWindow(host, available),
    touch = new BurikoNativeTouch(input, new BurikoNativeClock(() => 77), touchWindow),
    waits = [],
    broadcastTouchCounts = [],
    receiver = new BurikoMainWindowMessageReceiver(
      messages,
      {
        dispatch: (message) => {
          waits.push(message);
          if (message === 0x240) broadcastTouchCounts.push(input.touchPositions.length);
        },
      },
      input,
      {push() {}},
      host,
      {findPointerReceiver: () => null},
      null,
      null,
      null,
      null,
      touch,
    );
  const ingress = new BurikoMainTouchInput(host, input, messages, touch, touchWindow),
    mouse = new BurikoMainMouseInput(host, input, messages, null, (event) =>
      ingress.suppressCompatibilityMouse(event),
    );
  return {
    canvas,
    parent,
    document,
    host,
    input,
    messages,
    touchWindow,
    touch,
    receiver,
    ingress,
    mouse,
    waits,
    broadcastTouchCounts,
  };
}

test('first touch uses shared queued WM_TOUCH sidecar before owned mouse and broadcasts once', () => {
  const s = fixture();
  assert.equal(s.canvas.style.touchAction, 'none');
  assert.equal(s.touch.setRegistration(1), 1);
  const event = s.canvas.fire('pointerdown');
  assert.equal(event.defaultPrevented, true);
  assert.equal(s.host.focusCalls, 1);
  assert.equal(s.input.queryKey(1) & 0x8000, 0x8000);
  assert.equal(s.input.pointerAvailable, true);
  assert.deepEqual(s.input.screenCursorPosition(), [-70, 100]);
  assert.deepEqual(s.input.touchPositions, []);
  const touchMessage = s.messages.take();
  assert.equal(touchMessage.message, 0x240);
  assert.equal(touchMessage.wParam, 1);
  assert.deepEqual(s.messages.touchBatch(touchMessage), [
    {
      id: 1,
      x: -7000,
      y: 10000,
      flags: 0x12,
      mask: 5,
      time: 123,
      contactWidth: 600,
      contactHeight: 1000,
    },
  ]);
  assert.equal(s.messages.dispatch(touchMessage), 1);
  assert.equal(s.messages.touchBatch(touchMessage), null);
  assert.deepEqual(s.input.pointerPosition(), s.input.touchPositions[0]);
  assert.equal(s.input.totalPresses(7), 1);
  assert.equal(s.messages.dispatchNext().message.message, 0x201);
  assert.deepEqual(s.waits, [0x240, 0x201]);
  assert.deepEqual(s.broadcastTouchCounts, [0]);
  s.mouse.dispose();
  s.ingress.dispose();
  assert.equal(s.canvas.style.touchAction, 'pan-x');
});

test('stable two-contact ordering, compatibility suppression, and clear cancel queued contacts', () => {
  const s = fixture();
  s.touch.setRegistration(1);
  s.canvas.fire('pointerdown');
  s.messages.dispatchNext();
  s.messages.dispatchNext();
  s.canvas.fire('pointerdown', {pointerId: 2, isPrimary: false, clientX: 30});
  assert.equal(s.messages.dispatchNext().message.message, 0x240);
  assert.equal(s.touch.copyContacts(null), 2);
  assert.equal(s.messages.take(), null);
  s.canvas.fire('mousedown', {
    pointerType: undefined,
    buttons: 1,
    sourceCapabilities: {firesTouchEvents: true},
  });
  assert.equal(s.messages.take(), null);
  s.canvas.fire('pointermove', {pointerId: 2, isPrimary: false, clientX: 31});
  s.canvas.fire('pointerup', {pointerId: 2, isPrimary: false, clientX: 31});
  assert.equal(s.messages.dispatchNext().message.message, 0x240);
  assert.equal(s.messages.dispatchNext().message.message, 0x240);
  assert.equal(s.touch.copyContacts(null), 1);
  s.canvas.fire('pointerup');
  assert.equal(s.messages.dispatchNext().message.message, 0x240);
  assert.equal(s.messages.dispatchNext().message.message, 0x202);
  assert.equal(s.input.queryKey(7) & 0x8000, 0);
  s.canvas.fire('pointerdown', {pointerId: 3});
  s.ingress.deactivate();
  assert.equal(s.messages.dispatchNext().result, 0);
  assert.equal(s.messages.dispatchNext(), null);
  assert.equal(s.touch.copyContacts(null), 0);
  s.mouse.dispose();
  s.ingress.dispose();
});

test('forged WM_TOUCH integer cannot retrieve a batch and batch admission is bounded', () => {
  const s = fixture();
  s.touch.setRegistration(1);
  assert.equal(s.messages.send('main', 0x240, 1, 1), 0);
  assert.equal(s.touch.copyContacts(null), 0);
  assert.throws(
    () =>
      s.messages.enqueuePhysicalTouch(
        Array.from({length: 257}, () => ({
          id: 1,
          x: 0,
          y: 0,
          flags: 2,
          mask: 0,
          time: 0,
          contactWidth: 0,
          contactHeight: 0,
        })),
      ),
    /1 to 256/,
  );
  s.mouse.dispose();
  s.ingress.dispose();
});

test('registration change invalidates queued contact and preserves existing history', () => {
  const s = fixture();
  s.touch.configureHistory(4, 0);
  s.touch.setRegistration(1);
  s.canvas.fire('pointerdown');
  s.messages.dispatchNext();
  s.messages.dispatchNext();
  s.canvas.fire('pointermove', {clientX: 20});
  s.messages.dispatchNext();
  s.messages.dispatchNext();
  const positions = {bytes: new Uint8Array(16), offset: 0},
    angles = {bytes: new Uint8Array(8), offset: 0};
  assert.equal(s.touch.copyHistory(positions, angles, 0, 1), 1);
  s.canvas.fire('pointermove', {clientX: 25});
  assert.equal(s.touch.setRegistration(0), 1);
  assert.equal(s.touchWindow.registered, false);
  assert.equal(s.touch.copyContacts(null), 0);
  assert.equal(s.touch.copyHistory(positions, angles, 0, 1), 1);
  assert.equal(s.messages.dispatchNext().result, 0);
  assert.equal(s.messages.dispatchNext(), null);
  s.touch.setRegistration(1);
  s.canvas.fire('pointerdown', {pointerId: 2});
  assert.equal(s.messages.dispatchNext().result, 1);
  s.mouse.dispose();
  s.ingress.dispose();
});

test('touch sidecar retains FIFO order around posted messages and caps pending batches', () => {
  const s = fixture();
  s.touch.setRegistration(1);
  s.messages.post({target: 'main', message: 0x9001, wParam: 0, lParam: 0});
  const sample = {
    id: 1,
    x: -7000,
    y: 10000,
    flags: 0x12,
    mask: 0,
    time: 0,
    contactWidth: 0,
    contactHeight: 0,
  };
  for (let index = 0; index < 256; index++) s.messages.enqueuePhysicalTouch([sample]);
  assert.equal(s.messages.enqueuePhysicalTouch([sample]), false);
  assert.equal(s.messages.dispatchNext().message.message, 0x9001);
  assert.equal(s.messages.dispatchNext().message.message, 0x240);
  s.messages.enqueuePhysicalTouch([sample]);
  s.mouse.dispose();
  s.ingress.dispose();
});

test('unregistered touch maps to native mouse while child contacts stay outside the canvas owner', () => {
  const s = fixture();
  const child = new Element();
  assert.equal(s.canvas.fire('pointerdown').defaultPrevented, true);
  assert.equal(s.messages.dispatchNext().message.message, 0x201);
  assert.equal(s.touch.copyContacts(null), 0);
  assert.equal(s.input.queryKey(1) & 0x8000, 0x8000);
  s.canvas.fire('mousedown', {
    pointerType: undefined,
    buttons: 1,
    sourceCapabilities: {firesTouchEvents: true},
  });
  assert.equal(s.messages.take(), null);
  s.canvas.fire('pointermove', {clientX: 18});
  assert.equal(s.messages.dispatchNext().message.message, 0x200);
  s.canvas.fire('pointerup', {clientX: 18});
  assert.equal(s.messages.dispatchNext().message.message, 0x202);
  assert.equal(s.input.queryKey(1) & 0x8000, 0);
  s.touch.setRegistration(1);
  s.canvas.fire('pointerdown', {target: child});
  assert.equal(s.messages.take(), null);
  s.canvas.fire('pointerdown', {width: undefined, height: undefined, timeStamp: NaN});
  const message = s.messages.take();
  assert.equal(s.messages.touchBatch(message)[0].mask, 0);
  s.messages.dispatch(message);
  s.messages.dispatchNext();
  s.canvas.fire('pointercancel');
  assert.equal(s.messages.dispatchNext().message.message, 0x240);
  assert.equal(s.messages.dispatchNext().message.message, 0x202);
  assert.equal(s.touch.copyContacts(null), 0);
  assert.equal(s.input.asynchronousKeyState(1) & 0x8000, 0);
  s.mouse.dispose();
  s.ingress.dispose();
});

test('absent digitizer capability leaves ordinary browser compatibility mouse ingress available', () => {
  const s = fixture(false);
  assert.equal(s.canvas.style.touchAction, 'pan-x');
  assert.equal(s.touch.setRegistration(1), 0);
  s.canvas.fire('pointerdown');
  assert.equal(s.messages.take(), null);
  s.canvas.fire('mousedown', {
    pointerType: undefined,
    buttons: 1,
    sourceCapabilities: {firesTouchEvents: true},
  });
  assert.equal(s.messages.take().message, 0x201);
  s.mouse.dispose();
  s.ingress.dispose();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBrowserMainWindow} from '../dist/engines/buriko/native/browser-main-window.js';
import {BurikoMainWindowCallbackBinding} from '../dist/engines/buriko/native/main-window-callbacks.js';
import {BurikoMainWindowMessageReceiver} from '../dist/engines/buriko/native/main-window-messages.js';
import {BurikoInlineTextControl} from '../dist/engines/buriko/native/inline-text-control.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {BurikoNativeInput} from '../dist/engines/buriko/native/input.js';
import {BurikoWindowMessages} from '../dist/engines/buriko/native/window-messages.js';
import {BurikoWindowMessages as BurikoWaitWindowMessages} from '../dist/engines/buriko/native/procedure.js';
import {BurikoNativeNotifications} from '../dist/engines/buriko/native/notification-queue.js';
import {BurikoDisplayManager} from '../dist/engines/buriko/native/display-manager.js';
import {BurikoDisplayObjectEnvironment} from '../dist/engines/buriko/native/display-object.js';
import {BurikoDisplayDamage} from '../dist/engines/buriko/native/display-damage.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoKeyboardMessages} from '../dist/engines/buriko/native/keyboard-messages.js';
import {BurikoBpThread, push32} from '../dist/engines/buriko/bp/state.js';
import {createGroup80MainClose} from '../dist/engines/buriko/native/group-80-main-close.js';

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.style = {};
    this.children = [];
    this.listeners = new Map();
    this.disabled = false;
    this.removed = false;
  }
  append(child) {
    this.children.push(child);
    child.parent = this;
  }
  remove() {
    this.removed = true;
  }
  setAttribute(name, value) {
    this[name] = value;
  }
  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }
  focus() {}
}

test('main lifecycle publishes real readiness, preserves nested close order and FIFO quit', () => {
  const document = {title: '', createElement: (tag) => new Element(tag)},
    parent = document.createElement('div'),
    canvas = document.createElement('canvas'),
    display = new BurikoNativeDisplayState(16, 8),
    compositor = new BurikoBitmapCompositor(),
    manager = new BurikoDisplayManager(
      new BurikoDisplayObjectEnvironment(
        compositor,
        new BurikoDisplayDamage(64, {left: 0, top: 0, right: 15, bottom: 7}),
      ),
      new BurikoSurfaces(null, compositor, new BurikoDistributedAllocator(1)),
      display,
    ),
    callbacks = new BurikoMainWindowCallbackBinding(display),
    host = new BurikoBrowserMainWindow(document, parent, canvas, manager, callbacks),
    input = new BurikoNativeInput(display, new BurikoNativeClock(() => 0)),
    messages = new BurikoWindowMessages(input),
    waits = new BurikoWaitWindowMessages(),
    notifications = new BurikoNativeNotifications(),
    inline = new BurikoInlineTextControl(
      host,
      new BurikoNativeFonts(new BurikoNativeText()),
      {},
      messages,
      new BurikoKeyboardMessages(messages),
    ),
    order = [];
  messages.createMainTarget();
  host.bindCloseMenu(input, messages);
  const thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 4,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    slots = createGroup80MainClose(host),
    setPolicy = (value) => {
      push32(thread, value);
      assert.equal(slots.find((slot) => slot.secondary === 0x68).execute({thread}), 0);
    },
    postClose = () => {
      assert.equal(slots.find((slot) => slot.secondary === 0x69).execute({thread}), 0);
    };
  const receiver = new BurikoMainWindowMessageReceiver(
    messages,
    waits,
    input,
    notifications,
    host,
    {},
    null,
    null,
    null,
    {host, inline},
  );
  callbacks.bindReadyReceiver(host, receiver);
  assert.equal(callbacks.isReady(), false);
  assert.equal(host.setCaption('early'), false);
  assert.equal(document.title, '');
  assert.throws(() => messages.bindMainReceiver({receive: () => 0}), /already bound/);
  const broadcast = waits.dispatch.bind(waits);
  waits.dispatch = (message, wParam, lParam) => {
    order.push(`broadcast:${message}`);
    if (message === 2) {
      assert.equal(callbacks.isReady(), true);
      assert.equal(messages.mainTarget(), 'main');
    }
    broadcast(message, wParam, lParam);
  };
  assert.equal(messages.send('main', 1, 0, 0), 0);
  assert.equal(callbacks.isReady(), true);
  assert.equal(host.setCaption('ready'), true);
  assert.equal(document.title, 'ready');

  setPolicy(0);
  postClose();
  const rejectedClose = messages.takePostedEvent();
  assert.equal(rejectedClose.kind, 'window');
  assert.equal(rejectedClose.message.message, 0x10);
  assert.equal(messages.dispatch(rejectedClose.message), 0);
  assert.deepEqual(notifications.take(), {type: 2, value1: 0, value2: 0});
  assert.equal(input.inputEventCount, 1);
  assert.equal(callbacks.isReady(), true);
  assert.equal(parent.removed, false);

  const originalClose = inline.close.bind(inline),
    originalDetach = host.detachScopedWindow.bind(host);
  inline.close = () => {
    order.push('inline');
    return originalClose();
  };
  host.detachScopedWindow = () => {
    order.push('detach');
    originalDetach();
  };
  setPolicy(1);
  const child = messages.createTarget();
  messages.invalidate(child);
  postClose();
  messages.post({target: 'main', message: 0x9001, wParam: 0, lParam: 0});
  const close = messages.takePostedEvent();
  assert.equal(close.kind, 'window');
  assert.equal(close.message.message, 0x10);
  messages.dispatch(close.message);
  assert.deepEqual(order.slice(-4), ['broadcast:16', 'inline', 'broadcast:2', 'detach']);
  assert.equal(input.inputEventCount, 2);
  assert.equal(callbacks.isReady(), false);
  assert.equal(messages.mainTarget(), null);
  assert.equal(parent.removed, true);
  messages.enqueuePhysicalTransitions(
    {target: 'main', message: 0x9001, wParam: 0, lParam: 0},
    [],
    true,
  );
  assert.equal(messages.takePostedEvent().message.message, 0x9001);
  assert.equal(messages.dispatch({target: 'main', message: 0x9001, wParam: 0, lParam: 0}), 0);
  assert.throws(() => messages.take(), /thread quit/);
  assert.deepEqual(messages.takePostedEvent(), {kind: 'quit', exitCode: 0});
  assert.equal(messages.takePostedEvent().message.message, 0x9001);
  assert.equal(messages.takePostedEvent(), null);
  assert.deepEqual(messages.take(), {target: child, message: 0xf, wParam: 0, lParam: 0});
});

test('direct WM_DESTROY detaches the scoped host and queues thread quit', () => {
  const document = {createElement: (tag) => new Element(tag)},
    parent = document.createElement('div'),
    canvas = document.createElement('canvas'),
    display = new BurikoNativeDisplayState(16, 8),
    compositor = new BurikoBitmapCompositor(),
    manager = new BurikoDisplayManager(
      new BurikoDisplayObjectEnvironment(
        compositor,
        new BurikoDisplayDamage(64, {left: 0, top: 0, right: 15, bottom: 7}),
      ),
      new BurikoSurfaces(null, compositor, new BurikoDistributedAllocator(1)),
      display,
    ),
    callbacks = new BurikoMainWindowCallbackBinding(display),
    host = new BurikoBrowserMainWindow(document, parent, canvas, manager, callbacks),
    input = new BurikoNativeInput(display, new BurikoNativeClock(() => 0)),
    messages = new BurikoWindowMessages(input),
    inline = new BurikoInlineTextControl(
      host,
      new BurikoNativeFonts(new BurikoNativeText()),
      {},
      messages,
      new BurikoKeyboardMessages(messages),
    );
  messages.createMainTarget();
  const receiver = new BurikoMainWindowMessageReceiver(
    messages,
    new BurikoWaitWindowMessages(),
    input,
    new BurikoNativeNotifications(),
    host,
    {},
    null,
    null,
    null,
    {host, inline},
  );
  callbacks.bindReadyReceiver(host, receiver);
  messages.send('main', 1, 0, 0);
  assert.equal(callbacks.isReady(), true);
  messages.send('main', 2, 0, 0);
  assert.equal(callbacks.isReady(), false);
  assert.equal(messages.mainTarget(), null);
  assert.equal(parent.removed, true);
  assert.deepEqual(messages.takePostedEvent(), {kind: 'quit', exitCode: 0});
});

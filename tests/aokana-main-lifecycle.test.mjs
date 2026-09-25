import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBrowserMainWindow} from '../dist/engines/buriko/games/aokana/native/browser-main-window.js';
import {AokanaMainWindowCallbackBinding} from '../dist/engines/buriko/games/aokana/native/main-window-callbacks.js';
import {AokanaMainWindowMessageReceiver} from '../dist/engines/buriko/games/aokana/native/main-window-messages.js';
import {AokanaInlineTextControl} from '../dist/engines/buriko/games/aokana/native/inline-text-control.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {AokanaNativeInput} from '../dist/engines/buriko/games/aokana/native/input.js';
import {AokanaWindowMessages} from '../dist/engines/buriko/games/aokana/native/window-messages.js';
import {AokanaWindowMessages as AokanaWaitWindowMessages} from '../dist/engines/buriko/games/aokana/native/procedure.js';
import {AokanaNativeNotifications} from '../dist/engines/buriko/games/aokana/native/notification-queue.js';
import {AokanaDisplayManager} from '../dist/engines/buriko/games/aokana/native/display-manager.js';
import {AokanaDisplayObjectEnvironment} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaKeyboardMessages} from '../dist/engines/buriko/games/aokana/native/keyboard-messages.js';
import {AokanaBpThread, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createGroup80MainClose} from '../dist/engines/buriko/games/aokana/native/group-80-main-close.js';

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
    display = new AokanaNativeDisplayState(16, 8),
    compositor = new AokanaBitmapCompositor(),
    manager = new AokanaDisplayManager(
      new AokanaDisplayObjectEnvironment(
        compositor,
        new AokanaDisplayDamage(64, {left: 0, top: 0, right: 15, bottom: 7}),
      ),
      new AokanaSurfaces(null, compositor, new AokanaDistributedAllocator(1)),
      display,
    ),
    callbacks = new AokanaMainWindowCallbackBinding(display),
    host = new AokanaBrowserMainWindow(document, parent, canvas, manager, callbacks),
    input = new AokanaNativeInput(display, new AokanaNativeClock(() => 0)),
    messages = new AokanaWindowMessages(input),
    waits = new AokanaWaitWindowMessages(),
    notifications = new AokanaNativeNotifications(),
    inline = new AokanaInlineTextControl(
      host,
      new AokanaNativeFonts(new AokanaNativeText()),
      {},
      messages,
      new AokanaKeyboardMessages(messages),
    ),
    order = [];
  messages.createMainTarget();
  host.bindCloseControl(input, messages);
  const thread = new AokanaBpThread({
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
  const receiver = new AokanaMainWindowMessageReceiver(
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
    display = new AokanaNativeDisplayState(16, 8),
    compositor = new AokanaBitmapCompositor(),
    manager = new AokanaDisplayManager(
      new AokanaDisplayObjectEnvironment(
        compositor,
        new AokanaDisplayDamage(64, {left: 0, top: 0, right: 15, bottom: 7}),
      ),
      new AokanaSurfaces(null, compositor, new AokanaDistributedAllocator(1)),
      display,
    ),
    callbacks = new AokanaMainWindowCallbackBinding(display),
    host = new AokanaBrowserMainWindow(document, parent, canvas, manager, callbacks),
    input = new AokanaNativeInput(display, new AokanaNativeClock(() => 0)),
    messages = new AokanaWindowMessages(input),
    inline = new AokanaInlineTextControl(
      host,
      new AokanaNativeFonts(new AokanaNativeText()),
      {},
      messages,
      new AokanaKeyboardMessages(messages),
    );
  messages.createMainTarget();
  const receiver = new AokanaMainWindowMessageReceiver(
    messages,
    new AokanaWaitWindowMessages(),
    input,
    new AokanaNativeNotifications(),
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

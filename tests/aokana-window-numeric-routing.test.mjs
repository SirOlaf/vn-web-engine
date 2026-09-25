import assert from 'node:assert/strict';
import test from 'node:test';
import {AokanaWindowMessages} from '../dist/engines/buriko/games/aokana/native/window-messages.js';
import {AokanaKeyboardMessages} from '../dist/engines/buriko/games/aokana/native/keyboard-messages.js';
import {AokanaInlineTextControl} from '../dist/engines/buriko/games/aokana/native/inline-text-control.js';
import {AokanaChildWindows} from '../dist/engines/buriko/games/aokana/native/child-windows.js';
import {AokanaPropertyEditors} from '../dist/engines/buriko/games/aokana/native/property-editor.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaBitmapText} from '../dist/engines/buriko/games/aokana/native/font-bitmap.js';

class Element {
  constructor(tagName, document) {
    this.tagName = tagName.toUpperCase();
    this.document = document;
    this.style = {};
    this.children = [];
    this.listeners = new Map();
    this.selectionStart = this.selectionEnd = 0;
    this.value = '';
    this.hidden = false;
  }
  append(...children) {
    for (const child of children) {
      this.children.push(child);
      child.parent = this;
    }
  }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
  }
  setAttribute(name, value) {
    this[name] = value;
  }
  addEventListener(name, callback) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(callback);
    this.listeners.set(name, listeners);
  }
  focus() {
    this.document.activeElement = this;
  }
  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  setRangeText(value, start, end) {
    this.value = this.value.slice(0, start) + value + this.value.slice(end);
    this.selectionStart = this.selectionEnd = start + value.length;
  }
  getBoundingClientRect() {
    return {
      left: parseFloat(this.style.left) || 0,
      top: parseFloat(this.style.top) || 0,
      width: parseFloat(this.style.width) || 0,
      height: parseFloat(this.style.height) || 0,
    };
  }
  getContext() {
    assert.fail('numeric routing fixture must not render');
  }
}

function document() {
  const result = {
    activeElement: null,
    createElement(tag) {
      return new Element(tag, result);
    },
  };
  return result;
}

function word() {
  return {bytes: new Uint8Array(8), offset: 0};
}

test('queued numeric messages reach live inline, child, and property owners; synchronous send stays main-only', async () => {
  const dom = document(),
    parent = dom.createElement('main'),
    input = {
      setPhysicalKey() {},
      setDequeuedKey() {},
      asynchronousKeyState() {
        return 0;
      },
    },
    messages = new AokanaWindowMessages(input),
    keyboard = new AokanaKeyboardMessages(messages),
    text = new AokanaNativeText(),
    fonts = new AokanaNativeFonts(text, {
      async create() {
        return {cssFamily: 'Fixture Sans', emSize: 18, horizontalScale: 1};
      },
    });
  text.selectMode(1);
  fonts.registerName(new TextEncoder().encode('Fixture Sans'), 0);
  messages.createMainTarget();
  const mainMessages = [];
  messages.bindMainReceiver({
    receive(message) {
      mainMessages.push(message);
      return message.message === 0x901 ? messages.send('main', 0x902, 0, 0) + 1 : 7;
    },
  });
  const dialogs = {transition() {}},
    display = new AokanaNativeDisplayState(800, 600),
    host = {
      display,
      document: dom,
      parent,
      focus() {},
      invalidateInline() {},
    },
    inline = new AokanaInlineTextControl(host, fonts, dialogs, messages, keyboard);
  assert.equal(await inline.create(10, 20, 120, 20, 0, 20, 16, 1), 0);
  const inlineTarget = inline.target;
  assert.equal(messages.hasTarget(inlineTarget), true);

  const compositor = new AokanaBitmapCompositor();
  compositor.defaultFormat = 1;
  const surfaces = new AokanaSurfaces(fonts, compositor, new AokanaDistributedAllocator(1));
  const children = new AokanaChildWindows(
    dom,
    parent,
    {clipboard: {async writeText() {}}},
    text,
    surfaces,
    compositor,
    new AokanaBitmapText(fonts, compositor),
    dialogs,
    messages,
    keyboard,
    {frameWidth: 2, frameHeight: 22, verticalScrollbarWidth: 15, horizontalScrollbarHeight: 16},
    text.encodeWide('Default title'),
    dom.createElement('canvas'),
  );
  children.initialize();
  const childOutput = word();
  assert.equal(
    children.create(childOutput, {bytes: text.encodeWide('Child'), offset: 0}, 10, 20, 32, 32, 0),
    0,
  );
  const childId = new DataView(childOutput.bytes.buffer).getUint32(0, true),
    childTarget = inlineTarget + 1;
  assert.equal(messages.hasTarget(childTarget), true);

  const properties = new AokanaPropertyEditors(
    dom,
    parent,
    text,
    messages,
    text.encodeWide('Title'),
  );
  const propertyOutput = word();
  assert.equal(properties.create(propertyOutput, null, null, null, 100, 200), 0);
  const propertyId = new DataView(propertyOutput.bytes.buffer).getUint32(0, true),
    propertyTarget = childTarget + 1;
  assert.equal(messages.hasTarget(propertyTarget), true);

  // The queued path enters each concrete owner's callback and awaits it.
  messages.post({target: inlineTarget, message: 0x102, wParam: 65, lParam: 0});
  const editEvent = messages.takePumpEvent();
  assert.equal(editEvent.kind, 'window');
  assert.equal(await messages.dispatchQueuedNumeric(editEvent.message), true);
  assert.equal(inline.element.value, 'A');

  messages.post({target: childTarget, message: 0x100, wParam: 0x41, lParam: 0x123456789n});
  const childEvent = messages.takePumpEvent();
  assert.equal(childEvent.kind, 'window');
  assert.equal(await messages.dispatchQueuedNumeric(childEvent.message), true);
  assert.deepEqual(messages.takePumpEvent(), {
    kind: 'window',
    message: {...childEvent.message, target: 'main'},
  });

  messages.post({target: propertyTarget, message: 0x10, wParam: 0, lParam: 0});
  const propertyEvent = messages.takePumpEvent();
  assert.equal(propertyEvent.kind, 'window');
  assert.equal(await messages.dispatchQueuedNumeric(propertyEvent.message), true);
  assert.deepEqual(messages.takePumpEvent(), {
    kind: 'window',
    message: {target: propertyTarget, message: 0x111, wParam: 2, lParam: 0},
  });

  assert.equal(messages.send(childTarget, 0x901, 0, 0), 0);
  assert.equal(messages.send('main', 0x901, 0, 0), 8);
  assert.deepEqual(
    mainMessages.map((message) => message.message),
    [0x901, 0x902],
  );

  inline.close();
  assert.equal(children.close(childId), 1);
  assert.equal(properties.destroy(propertyId), 0);
  for (const target of [inlineTarget, childTarget, propertyTarget]) {
    assert.equal(messages.hasTarget(target), false);
    assert.equal(
      await messages.dispatchQueuedNumeric({target, message: 0x100, wParam: 0, lParam: 0}),
      false,
    );
  }
});

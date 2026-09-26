import test from 'node:test';
import assert from 'node:assert/strict';
import {deviceServiceFixture} from './aokana-device-service-fixture.mjs';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoWindowTitle} from '../dist/engines/buriko/native/window-title.js';
import {createGroup80WindowTitle} from '../dist/engines/buriko/native/group-80-window-title.js';
import {BurikoPropertyEditors} from '../dist/engines/buriko/native/property-editor.js';
import {BurikoChildWindows} from '../dist/engines/buriko/native/child-windows.js';
import {BurikoBitmapText} from '../dist/engines/buriko/native/font-bitmap.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {BurikoKeyboardMessages} from '../dist/engines/buriko/native/keyboard-messages.js';

// DOM storage primitives only; no browser or image presentation is executed.
class Element {
  style = {};
  children = [];
  append(...children) {
    this.children.push(...children);
    for (const child of children) child.parent = this;
  }
  setAttribute(name, value) {
    this[name] = value;
  }
  remove() {
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
  }
}

test('80:66 updates actual caption and shared default property-window title', () => {
  const fixture = deviceServiceFixture(),
    host = fixture.controller.host,
    document = host.document,
    parent = new Element(),
    text = new BurikoNativeText(),
    title = new BurikoWindowTitle(text.encodeWide('Initial caption', 0)),
    dialogs = fixture.controller.inline.dialogs;
  document.createElement = () => new Element();
  dialogs.fallbackTitle = title.bytes;
  const properties = new BurikoPropertyEditors(
      document,
      parent,
      text,
      fixture.messages,
      title.bytes,
    ),
    compositor = fixture.manager.environment.compositor,
    children = new BurikoChildWindows(
      document,
      parent,
      {},
      text,
      fixture.manager.surfaces,
      compositor,
      new BurikoBitmapText(new BurikoNativeFonts(text), compositor),
      dialogs,
      fixture.messages,
      new BurikoKeyboardMessages(fixture.messages),
      {frameWidth: 0, frameHeight: 0, verticalScrollbarWidth: 0, horizontalScrollbarHeight: 0},
      title.bytes,
      fixture.canvas,
    ),
    [slot] = createGroup80WindowTitle(title, text, host, dialogs, children, properties),
    memory = new BurikoBpMemory(new Uint8Array(1024)),
    thread = new BurikoBpThread({id: 1, operandCapacity: 8, moduleCapacity: 0, frameCapacity: 0}),
    first = text.encodeWide('蒼の彼方のフォーリズム', 0),
    second = text.encodeWide('蒼空', 0);
  memory.globalMemory.set(first, 64);
  memory.globalMemory.set(second, 256);
  push32(thread, 64);
  assert.equal(slot.execute({thread, memory}), 0);
  assert.equal(document.title, '蒼の彼方のフォーリズム');
  assert.deepEqual(title.bytes.subarray(0, first.length), first);
  const retained = title.bytes.slice(second.length);
  push32(thread, 256);
  assert.equal(slot.execute({thread, memory}), 0);
  assert.equal(thread.stackIndex, 0);
  assert.equal(document.title, '蒼空');
  assert.deepEqual(title.bytes.subarray(0, second.length), second);
  assert.deepEqual(title.bytes.subarray(second.length), retained);
  assert.equal(dialogs.fallbackTitle, title.bytes);
  assert.equal(children.nativeWindowTitle, title.bytes);
  assert.equal(properties.nativeWindowTitle, title.bytes);
  const output = {bytes: memory.globalMemory, offset: 512};
  assert.equal(properties.create(output, null, null, null, 120, 180), 0);
  assert.equal(parent.children[0].children[0].textContent, '蒼空');
  const id = new DataView(memory.globalMemory.buffer).getUint32(512, true);
  assert.equal(properties.destroy(id), 0);
  assert.equal(parent.children.length, 0);
});

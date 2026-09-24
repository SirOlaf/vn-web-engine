import test from 'node:test';
import assert from 'node:assert/strict';
import {deviceServiceFixture} from './aokana-device-service-fixture.mjs';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, push32, pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaPropertyEditors} from '../dist/engines/buriko/games/aokana/native/property-editor.js';
import {createGroupE0ObjectProperties} from '../dist/engines/buriko/games/aokana/native/group-e0-object-properties.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
import {bitmapWrite32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';

// Synthetic DOM storage and event primitives only; no browser presentation.
class Element {
  children = [];
  style = {};
  listeners = new Map();
  hidden = false;
  textContent = '';
  constructor(tagName, document) {
    this.tagName = tagName;
    this.document = document;
  }
  append(...values) {
    for (const value of values) {
      this.children.push(value);
      value.parent = this;
    }
  }
  prepend(value) {
    this.children.unshift(value);
    value.parent = this;
  }
  setAttribute(name, value) {
    this[name] = value;
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  fire(type, extra = {}) {
    const event = {preventDefault() {}, ...extra};
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
  }
  focus() {
    this.document.active = this;
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  replaceChildren(...values) {
    this.children.length = 0;
    this.append(...values);
  }
  select() {
    this.selectionStart = 0;
    this.selectionEnd = this.value.length;
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
      left: parseFloat(this.style.left),
      top: parseFloat(this.style.top),
      width: parseFloat(this.style.width),
      height: parseFloat(this.style.height),
    };
  }
  getContext() {
    return {
      putImageData: (image, x, y) => {
        (this.draws ??= []).push({image, x, y});
      },
    };
  }
  setPointerCapture(id) {
    this.capture = id;
  }
  hasPointerCapture(id) {
    return this.capture === id;
  }
  releasePointerCapture() {
    this.capture = null;
  }
}
function document() {
  const result = {
    createElement(tag) {
      return new Element(tag, result);
    },
    createTextNode(text) {
      const node = new Element('#text', result);
      node.textContent = text;
      return node;
    },
  };
  result.parent = result.createElement('main');
  return result;
}
function controls(element, type) {
  return element.children.flatMap((child) => [
    ...(child.type === type ? [child] : []),
    ...controls(child, type),
  ]);
}

const all = (element) => element.children.flatMap((child) => [child, ...all(child)]);
const named = (parent, name) => all(parent).find((child) => child.textContent === name);

test('E0:20 binds actual Sprite fields and routes modal row edits through the display manager', async () => {
  const {manager, messages} = deviceServiceFixture(),
    host = document(),
    text = new AokanaNativeText(),
    editors = new AokanaPropertyEditors(
      host,
      host.parent,
      text,
      messages,
      text.encodeWide('Objects'),
    ),
    memory = new AokanaBpMemory(new Uint8Array(512)),
    view = new DataView(memory.globalMemory.buffer),
    pointer = (offset) => ({bytes: memory.globalMemory, offset}),
    thread = new AokanaBpThread({id: 1, operandCapacity: 16, moduleCapacity: 0, frameCapacity: 0}),
    [slot] = createGroupE0ObjectProperties(editors, manager);
  assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0xe0][0x20]);
  assert.equal(editors.create(pointer(16), null, null, null, 180, 140), 0);
  const editorId = view.getUint32(16, true);
  assert.equal(manager.surfaces.allocate(0, 3, 3, 1), 1);
  const source = manager.surfaces.snapshot(0);
  for (let y = 0; y < 3; y++)
    for (let x = 0; x < 3; x++)
      bitmapWrite32(source, source.offset + y * source.stride + x * 4, 0x204060);
  const handle = manager.createSprite(),
    sprite = manager.resolve(handle);
  assert.equal(sprite.initializeSimple(0, 0, 0, 0, 0, 3), 0);
  manager.move(handle, 1, 2);
  manager.setActivation(handle, 1);
  memory.globalMemory.set(text.encodeWide('Sprite properties'), 64);
  [32, editorId, handle, 64].forEach((value) => push32(thread, value));
  assert.equal(slot.execute({thread, memory}), 0);
  assert.equal(pop32(thread), 0);
  assert.equal(view.getUint32(32, true), 0);
  const value = (row) => {
    assert.equal(editors.getValue(pointer(40), pointer(44), editorId, 0, row), 0);
    return [view.getInt32(40, true), view.getInt32(44, true)];
  };
  assert.deepEqual(value(0), [handle | 0, 2]);
  assert.deepEqual(value(2), [1, 4]);
  assert.deepEqual(value(6), [1, 0]);
  assert.deepEqual(value(7), [2, 0]);
  assert.deepEqual(value(12), [0, 0]);
  assert.equal(named(host.parent, 'Object Type').parent.children[1].textContent, 'Sprite');
  const edit = async (name, next) => {
    named(host.parent, name).parent.fire('dblclick');
    const pending = editors.handleMessage(messages.take());
    const input = controls(host.parent, 'text')[0];
    input.value = String(next);
    named(host.parent, 'OK').fire('click');
    assert.equal(await pending, true);
  };
  await edit('Position X', 3);
  assert.deepEqual(sprite.position(), {x: 3, y: 2});
  await edit('Position Y', 4);
  assert.deepEqual(sprite.position(), {x: 3, y: 4});
  await edit('Effect Mode', 1);
  assert.equal(sprite.blendMode, 1);
  await edit('Transparency', 64);
  assert.equal(sprite.transparency, 64);
  // A manager mutation is visible on refresh through the original borrowed fields.
  manager.move(handle, 5, 6);
  sprite.setOffset(7, 8);
  sprite.setSecondaryOffset(9, 10);
  editors.refresh(editorId);
  assert.deepEqual(value(6), [5, 0]);
  assert.deepEqual(value(7), [6, 0]);
  assert.deepEqual(value(8), [7, 0]);
  assert.deepEqual(value(11), [10, 0]);
  assert.deepEqual(value(15), [64, 1]);
  // A fully configured mode-five Sprite adds nine raw logical-coordinate rows.
  const affineHandle = manager.createSprite(),
    affine = manager.resolve(affineHandle);
  assert.equal(
    affine.configureAffineBlend({sourceSurface: 0, pivotX: 0, pivotY: 0, angle: 0, perspective: 0}),
    0,
  );
  affine.setCoordinates(65536, 131072, 196608);
  affine.setCoordinateOffset(32768, 65536, 98304);
  affine.setSecondaryCoordinateOffset(16384, 32768, 49152);
  [36, editorId, affineHandle, 64].forEach((value) => push32(thread, value));
  assert.equal(slot.execute({thread, memory}), 0);
  assert.equal(pop32(thread), 0);
  assert.equal(view.getUint32(36, true), 1);
  for (const [row, expected] of [
    [13, 65536],
    [16, 32768],
    [19, 16384],
    [21, 49152],
  ]) {
    assert.equal(editors.getValue(pointer(40), pointer(44), editorId, 1, row), 0);
    assert.deepEqual([view.getInt32(40, true), view.getInt32(44, true)], [expected, 3]);
  }
  assert.equal(editors.destroy(editorId), 0);
});

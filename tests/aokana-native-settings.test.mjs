import assert from 'node:assert/strict';
import test from 'node:test';
import {AokanaModelessSettings} from '../dist/engines/buriko/games/aokana/native/modeless-settings.js';
import {AokanaProductKeyDialog} from '../dist/engines/buriko/games/aokana/native/product-key-dialog.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaPropertyEditors} from '../dist/engines/buriko/games/aokana/native/property-editor.js';
import {AokanaAnsiDialogs} from '../dist/engines/buriko/games/aokana/native/ansi-dialogs.js';
import {AokanaAnsiUi} from '../dist/engines/buriko/games/aokana/native/ansi-ui.js';
import {AokanaChildWindows} from '../dist/engines/buriko/games/aokana/native/child-windows.js';
import {AokanaBitmapText} from '../dist/engines/buriko/games/aokana/native/font-bitmap.js';
import {AokanaWindowMessages} from '../dist/engines/buriko/games/aokana/native/window-messages.js';
import {AokanaKeyboardMessages} from '../dist/engines/buriko/games/aokana/native/keyboard-messages.js';
import {createGroupB0Children} from '../dist/engines/buriko/games/aokana/native/group-b0-children.js';
import {createGroupB0Properties} from '../dist/engines/buriko/games/aokana/native/group-b0-properties.js';
import {createGroupB0Dialogs} from '../dist/engines/buriko/games/aokana/native/group-b0-dialogs.js';
import {AokanaSelectionDialog} from '../dist/engines/buriko/games/aokana/native/selection-dialog.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';

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
function initial(values = Array(9).fill(0)) {
  return {bytes: new Uint8Array(new Int32Array(values).buffer), offset: 0};
}
function out() {
  return {bytes: new Uint8Array(16), offset: 0};
}
function vmSlots(definitions) {
  const slots = new Map(definitions.map((slot) => [slot.secondary, slot]));
  assert.equal(slots.size, definitions.length);
  for (const slot of definitions)
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0xb0][slot.secondary]);
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 32,
    moduleCapacity: 128,
    frameCapacity: 128,
  });
  const memory = new AokanaBpMemory(new Uint8Array(2048));
  const h = {thread, memory};
  return {
    thread,
    memory,
    slots,
    async run(id, values) {
      for (const value of values) push32(thread, value);
      assert.equal(await slots.get(id).execute(h), 0);
    },
    pop() {
      return pop32(thread);
    },
    write(at, bytes) {
      memory.globalMemory.set(bytes, at);
    },
    view: new DataView(memory.globalMemory.buffer),
  };
}
function event(output) {
  const view = new DataView(output.bytes.buffer);
  return [view.getInt32(0, true), view.getInt32(4, true)];
}

test('native modeless queue keeps the first and newest events when its fixed tail link is overwritten', () => {
  const host = document();
  const settings = new AokanaModelessSettings(host, host.parent, {transition() {}});
  const {id, result} = settings.create(0, initial());
  assert.equal(result, 0);
  const slider = controls(host.parent, 'range')[0];
  for (const value of [10, 20, 30]) {
    slider.value = String(value);
    slider.fire('input');
  }
  const output = out();
  assert.equal(settings.poll(id, output), 0);
  assert.deepEqual(event(output), [0, 10]);
  assert.equal(settings.poll(id, output), 0);
  assert.deepEqual(event(output), [0, 30]);
  assert.equal(settings.poll(id, output), 1);
});

test('appending after a partial native queue drain exposes the freed-tail write', () => {
  const host = document();
  const settings = new AokanaModelessSettings(host, host.parent, {transition() {}});
  const {id} = settings.create(0, initial());
  const slider = controls(host.parent, 'range')[0];
  slider.value = '1';
  slider.fire('input');
  slider.value = '2';
  slider.fire('input');
  settings.poll(id, null);
  slider.value = '3';
  assert.throws(() => slider.fire('input'), /freed tail/);
});

test('native modeless setting values retain radio inversion and redundant visibility errors', () => {
  const host = document(),
    transitions = [];
  const settings = new AokanaModelessSettings(host, host.parent, {
    transition(value) {
      transitions.push(value);
    },
  });
  const {id} = settings.create(0, initial([200, -1, 10, 20, 30, 0, 1, 1, 0]));
  assert.deepEqual(
    controls(host.parent, 'range').map((control) => control.value),
    ['128', '0', '10', '20', '30'],
  );
  assert.deepEqual(
    controls(host.parent, 'radio').map((control) => control.checked),
    [true, false, false, true, true, false, false, true],
  );
  assert.equal(settings.show(id, 0), 0x80000000);
  assert.equal(settings.show(id, 7), 0);
  assert.equal(settings.show(id, 1), 0x80000000);
  assert.equal(settings.destroy(id), 0);
  assert.deepEqual(transitions, [true, false]);
  assert.equal(settings.poll(id, null), 0x80000000);
  assert.equal(host.parent.children.length, 0);
});

test('host final close removes a visible modeless panel and its pending event', () => {
  const host = document(),
    transitions = [];
  const settings = new AokanaModelessSettings(host, host.parent, {
    transition(value) {
      transitions.push(value);
    },
  });
  const {id, result} = settings.create(0, initial());
  assert.equal(result, 0);
  assert.equal(settings.show(id, 1), 0);
  const slider = controls(host.parent, 'range')[0];
  slider.value = '37';
  slider.fire('input');
  assert.equal(host.parent.children.length, 1);

  settings.disposeAll();
  settings.disposeAll();
  assert.equal(host.parent.children.length, 0);
  assert.deepEqual(transitions, [true, false]);
  assert.equal(settings.poll(id, null), 0x80000000);
});

test('settings poll writes its two DWORDs before the indivisible NULL-pointer store', () => {
  const host = document();
  const settings = new AokanaModelessSettings(host, host.parent, {transition() {}});
  const {id} = settings.create(0, initial());
  const slider = controls(host.parent, 'range')[0];
  slider.value = '37';
  slider.fire('input');
  const bytes = new Uint8Array(12).fill(0xa5);
  assert.throws(() => settings.poll(id, {bytes, offset: 0}), /next-pointer write/);
  assert.deepEqual([...bytes], [0, 0, 0, 0, 37, 0, 0, 0, 0xa5, 0xa5, 0xa5, 0xa5]);
  const output = out();
  assert.equal(settings.poll(id, output), 0);
  assert.deepEqual(event(output), [0, 37]);
});

test('Unicode product-key filtering retains the cross-field discard latch and ASCII ranges', () => {
  const dialog = new AokanaProductKeyDialog({}, {}, {}, new AokanaNativeText());
  assert.equal(dialog.acceptCharacter(0x3042, false), false);
  assert.equal(dialog.acceptCharacter(65, false), false);
  assert.equal(dialog.acceptCharacter(65, false), true);
  assert.equal(dialog.acceptCharacter(122, false), true);
  assert.equal(dialog.acceptCharacter(45, false), false);
  assert.equal(dialog.acceptCharacter(65, true), false);
  assert.equal(dialog.acceptCharacter(57, true), true);
  assert.equal(dialog.acceptCharacter(0xd800, false), false);
  assert.equal(dialog.acceptCharacter(8, false), false);
  assert.equal(dialog.acceptCharacter(8, false), true);
});

test('product-key acceptance reads each field as UTF-16 but always writes UTF-8 and three separators', async () => {
  const host = document(),
    text = new AokanaNativeText();
  const dialog = new AokanaProductKeyDialog(
    host,
    host.parent,
    {
      async withNativeModal(operation) {
        return operation();
      },
    },
    text,
  );
  const output = {bytes: new Uint8Array(200).fill(0xa5), offset: 2};
  const pending = dialog.show(output, null, null, 0);
  const inputs = controls(host.parent, 'text');
  inputs[0].value = 'あ';
  inputs[1].value = 'B'.repeat(40);
  inputs[2].value = '';
  inputs[3].value = 'C';
  controls(host.parent, 'button')[0].fire('click');
  assert.equal(await pending, 1);
  assert.equal(
    new TextDecoder().decode(output.bytes.subarray(2, output.bytes.indexOf(0, 2))),
    `あ-${'B'.repeat(32)}--C`,
  );
  assert.equal(output.bytes[1], 0xa5);
  assert.equal(text.mode, 0);
});

test('surface creation consumes IDs before validation and destroys old ownership first', () => {
  const surfaces = new AokanaSurfaces(
    new AokanaNativeFonts(new AokanaNativeText(), {}),
    new AokanaBitmapCompositor(),
    new AokanaDistributedAllocator(1),
  );
  assert.equal(surfaces.allocate(5, 1, 1, 2), 1);
  assert.equal(surfaces.imageId(5), 0);
  surfaces.fill(5, 0x12345678);
  const alias = surfaces.snapshot(5);
  assert.equal(surfaces.allocate(5, 1, 1, 8), 0);
  assert.equal(surfaces.snapshot(5), null);
  assert.throws(() => alias.storage.range(0, 4, true), /released/);
  assert.equal(surfaces.allocate(5, 0, 2, 7), 1);
  assert.equal(surfaces.imageId(5), 2);
  assert.equal(surfaces.snapshot(5).format, 1);
  assert.equal(surfaces.snapshot(5).storage.bytes.length, 0);
  surfaces.preserveImageIds = 1;
  assert.equal(surfaces.allocate(5, 1, 1, 1), 1);
  assert.equal(surfaces.imageId(5), 2);
});

test('surface release drops bitmap ownership before movie removal and preserves outer recursive lock', () => {
  const allocator = new AokanaDistributedAllocator(1);
  const surfaces = new AokanaSurfaces(
    new AokanaNativeFonts(new AokanaNativeText(), {}),
    new AokanaBitmapCompositor(),
    allocator,
  );
  surfaces.allocate(1, 1, 1, 2);
  const record = surfaces.record(1);
  record.movieId = 9;
  record.frame = 12;
  const removed = [];
  surfaces.attachMovies({
    remove(id) {
      removed.push([id, surfaces.snapshot(1), record.movieId, record.frame]);
      return 1;
    },
  });
  assert.equal(surfaces.lock(1), 1);
  assert.equal(surfaces.release(1), 1);
  assert.deepEqual(removed, [[9, null, 9, 12]]);
  assert.equal(record.movieId, -1);
  assert.equal(record.frame, -1);
  assert.equal(surfaces.unlock(1), 1);
  assert.throws(() => surfaces.unlock(1), /does not own/);
});

test('property values retain the native binary32 Q16 display conversion', async () => {
  const {formatPropertyScalar, formatPropertySource} =
    await import('../dist/engines/buriko/games/aokana/native/property-values.js');
  assert.equal(formatPropertyScalar(3, 2147483647), '32768.000000');
  assert.equal(formatPropertyScalar(3, -2147483648), '-32768.000000');
  assert.equal(formatPropertyScalar(3, 1), '0.000015');
  assert.equal(formatPropertyScalar(3, 512), '0.007813');
  assert.equal(formatPropertyScalar(3, -512), '-0.007813');
  assert.equal(formatPropertyScalar(1, -1), '4294967295');
  assert.equal(formatPropertyScalar(2, 1), '0x00000001');
  assert.equal(formatPropertyScalar(4, -1), 'TRUE');
  assert.deepEqual(formatPropertySource(-1, null, new AokanaNativeText()), {result: 0x8000000d});
});

test('property edit filters preserve protected prefixes, selection-blind punctuation and pasted-text distinction', async () => {
  const {propertyEditCharacter: character, propertyEditDeleteAllowed: canDelete} =
    await import('../dist/engines/buriko/games/aokana/native/property-values.js');
  assert.equal(character(0, 45, '123', 0), 45);
  assert.equal(character(0, 45, '-123', 0), null);
  assert.equal(character(0, 45, '', 0), 45);
  assert.equal(character(3, 46, '-12', 1), null);
  assert.equal(character(3, 46, '-12', 2), 46);
  assert.equal(character(3, 46, '1.2', 3), null);
  assert.equal(character(2, 97, '0x00', 2), 65);
  assert.equal(character(2, 57, '0x00', 1), null);
  assert.equal(character(2, 8, '0x00', 2), null);
  assert.equal(character(2, 8, '0x00', 3), 8);
  assert.equal(character(1, 0x1a, '12', 0), 0x1a);
  assert.equal(character(5, 0x3042, '', 0), 0x3042);
  assert.equal(canDelete(2, 1), false);
  assert.equal(canDelete(2, 2), true);
});

test('window FIFO distinguishes physical arrival, dequeue state, and synthetic keyboard posting', async () => {
  const {AokanaWindowMessages} =
    await import('../dist/engines/buriko/games/aokana/native/window-messages.js');
  const calls = [];
  const queue = new AokanaWindowMessages({
    setPhysicalKey(key, down) {
      calls.push(['physical', key, down]);
    },
    setDequeuedKey(key, down) {
      calls.push(['dequeued', key, down]);
    },
  });
  queue.enqueuePhysicalKey(0xf8000000, 65, true, 0x1e0001);
  queue.post({target: 'main', message: 0x100, wParam: 66, lParam: 0xfeed12345678n});
  queue.enqueuePhysicalKey('main', 65, false, 0xc01e0001);
  assert.deepEqual(calls, [
    ['physical', 65, true],
    ['physical', 65, false],
  ]);
  assert.equal(queue.pending, 3);
  assert.equal(queue.take().target, 0xf8000000);
  assert.deepEqual(calls.at(-1), ['dequeued', 65, true]);
  const before = calls.length;
  assert.equal(queue.take().lParam, 0xfeed12345678n);
  assert.equal(calls.length, before);
  assert.equal(queue.take().message, 0x101);
  assert.deepEqual(calls.at(-1), ['dequeued', 65, false]);
  assert.equal(queue.take(), null);
  assert.equal(queue.pending, 0);
  queue.post({target: 'main', message: 0x8001, wParam: 0n, lParam: -1n});
  assert.equal(queue.take().lParam, -1n);
});

test('child scroll properties retain engine positions independently of host clamping', async () => {
  const {AokanaChildScroll} =
    await import('../dist/engines/buriko/games/aokana/native/child-scroll.js');
  const scroll = new AokanaChildScroll(3);
  assert.equal(scroll.setProperty(0, (10 << 16) | 50), 0);
  assert.equal(scroll.setProperty(1, (20 << 16) | 25), 0);
  assert.equal(scroll.setProperty(2, 26), 0x8000000d);
  assert.equal(scroll.setProperty(2, 25), 0);
  assert.equal(scroll.bars[0].position, 25);
  assert.equal(scroll.getProperty(2).value, 0);
  scroll.notify(0, (100 << 16) | 5);
  assert.equal(scroll.bars[0].position, 50);
  assert.equal(scroll.getProperty(2).value, 100);
  assert.equal(scroll.setProperty(0, 0), 0);
  assert.equal(scroll.bars[0].position, 0);
  assert.equal(scroll.getProperty(0).value, 50);
  assert.equal(scroll.getProperty(2).value, 100);
  scroll.notify(0, 1);
  assert.equal(scroll.bars[0].position, 0);
  assert.equal(scroll.getProperty(2).value, 1);
});

test('child scroll notifications use different horizontal and vertical increment bounds', async () => {
  const {AokanaChildScroll} =
    await import('../dist/engines/buriko/games/aokana/native/child-scroll.js');
  const scroll = new AokanaChildScroll(3);
  scroll.setProperty(0, 5);
  scroll.setProperty(1, 5);
  scroll.notify(0, (4 << 16) | 5);
  scroll.notify(1, (4 << 16) | 5);
  scroll.notify(0, 1);
  scroll.notify(1, 1);
  assert.deepEqual(scroll.positions, [5, 5]);
  assert.equal(scroll.bars[0].position, 4);
  assert.equal(scroll.bars[1].position, 4);
  assert.equal(scroll.setProperty(5, 0), 0);
  assert.throws(() => scroll.wheel(120 << 16), /IDIV/);
  scroll.setProperty(5, 1);
  assert.throws(() => scroll.wheel(120 << 16), /uninitialized.*cbSize/);
  assert.deepEqual(scroll.positions, [5, 5]);
  scroll.wheel(0);
  assert.equal(new AokanaChildScroll(0).setProperty(0, 2), 0x8000000c);
});

test('child DIB presentation uses format-derived depth, DWORD row alignment, and opaque BI_RGB pixels', async () => {
  const {aokanaChildDibPixels} =
    await import('../dist/engines/buriko/games/aokana/native/child-bitmap.js');
  const {AokanaBitmapStorage} =
    await import('../dist/engines/buriko/games/aokana/native/bitmap.js');
  const bitmap = {
    storage: new AokanaBitmapStorage(Uint8Array.of(0, 0x7c, 99, 99, 0xe0, 3), true),
    offset: 0,
    stride: 2,
    width: 1,
    height: 2,
    format: 0,
    bytesPerPixel: 4,
  };
  assert.deepEqual([...aokanaChildDibPixels(bitmap)], [255, 0, 0, 255, 0, 255, 0, 255]);
  const rgba = {
    ...bitmap,
    storage: new AokanaBitmapStorage(Uint8Array.of(1, 2, 3, 0), true),
    width: 1,
    height: 1,
    format: 2,
  };
  assert.deepEqual([...aokanaChildDibPixels(rgba)], [3, 2, 1, 255]);
  assert.equal(aokanaChildDibPixels({...bitmap, format: 6}), null);
  assert.throws(() => aokanaChildDibPixels({...bitmap, format: 3}), /uninitialized.*color table/);
});

function named(element, name) {
  return element.children.flatMap((child) => [
    ...(child.textContent === name ? [child] : []),
    ...named(child, name),
  ]);
}
async function editor() {
  const {AokanaWindowMessages} =
    await import('../dist/engines/buriko/games/aokana/native/window-messages.js');
  const messages = new AokanaWindowMessages({setPhysicalKey() {}, setDequeuedKey() {}});
  const host = document(),
    text = new AokanaNativeText();
  const service = new AokanaPropertyEditors(
    host,
    host.parent,
    text,
    messages,
    text.encodeWide('Native title'),
  );
  const pointer = (value) => ({bytes: text.encodeWide(value), offset: 0});
  const output = out();
  service.create(output, null, pointer('Description'), initial([-12, 34]), 100, 200);
  const id = new DataView(output.bytes.buffer).getUint32(0, true);
  service.addTab(null, id, pointer('First tab'));
  return {service, host, messages, text, id, pointer};
}

test('property records retain static values and compare live BOOL values by zero/nonzero', async () => {
  const {service, id, pointer} = await editor();
  const scalar = initial([5]),
    boolean = initial([2]);
  service.addRow(null, id, 0, pointer('Static'), 0, scalar, 0, 1);
  service.addRow(null, id, 0, pointer('Boolean'), 4, boolean, 1, 1);
  new DataView(scalar.bytes.buffer).setInt32(0, 7, true);
  new DataView(boolean.bytes.buffer).setInt32(0, 3, true);
  service.refresh(id);
  const output = out(),
    type = out();
  service.getValue(output, type, id, 0, 0);
  assert.equal(event(output)[0], 5);
  service.getValue(output, type, id, 0, 1);
  assert.equal(event(output)[0], 2);
  assert.equal(event(type)[0], 4);
  new DataView(boolean.bytes.buffer).setInt32(0, 0, true);
  service.refresh(id);
  service.getValue(output, null, id, 0, 1);
  assert.equal(event(output)[0], 0);
  assert.equal(service.refresh(0x12345678), 0);
  assert.equal(service.getValue(null, null, id, 1, 0), 0x80000014);
  assert.equal(service.getValue(null, null, id, 0, 20), 0x8000001f);
});

test('property UI events wait for the shared FIFO and MOVUPS failures retain the event', async () => {
  const {service, host, messages, id, pointer} = await editor();
  service.addButton(null, id, pointer('Apply'));
  named(host.parent, 'Apply')[0].fire('click');
  const output = out();
  assert.equal(service.poll(output, id), 0x8000001f);
  await service.handleMessage(messages.take());
  const short = {bytes: new Uint8Array(15).fill(0xa5), offset: 0};
  assert.throws(() => service.poll(short, id), /MOVUPS/);
  assert.deepEqual([...short.bytes], Array(15).fill(0xa5));
  assert.equal(service.poll(output, id), 0);
  assert.deepEqual([...new Int32Array(output.bytes.buffer)], [1, 0, 0, 0]);
  const target = messages.createTarget() - 1;
  await service.handleMessage({target, message: 0x10, wParam: 0, lParam: 0});
  await service.handleMessage(messages.take());
  assert.equal(service.poll(output, id), 0x8000001f);
  assert.equal(host.parent.children.length, 1);
});

test('property edit callbacks replace direct writes while accepted edits still emit events', async () => {
  const {service, host, messages, id, pointer} = await editor();
  const source = initial([3]),
    calls = [];
  service.addRow(
    null,
    id,
    0,
    pointer('Number'),
    0,
    source,
    1,
    1,
    null,
    null,
    (row, context, mode) => {
      calls.push([row.value, context, mode]);
      return 99;
    },
    'context',
  );
  const row = named(host.parent, 'Number')[0].parent;
  row.fire('dblclick');
  const pending = service.handleMessage(messages.take());
  controls(host.parent, 'text')[0].value = '１２xyz';
  named(host.parent, 'OK')[0].fire('click');
  await pending;
  assert.deepEqual(calls, [[12, 'context', 0]]);
  assert.equal(new DataView(source.bytes.buffer).getInt32(0, true), 3);
  const output = out();
  service.getValue(output, null, id, 0, 0);
  assert.equal(event(output)[0], 12);
  service.poll(output, id);
  assert.deepEqual(event(output), [4, 0]);
});

test('editing a live string changes only its formatted copy until source bytes change', async () => {
  const {service, host, messages, id, pointer, text} = await editor();
  const source = {bytes: new Uint8Array(100), offset: 0};
  source.bytes.set(text.encodeWide('Original'));
  service.addRow(null, id, 0, pointer('Text'), 5, source, 1, 1, null, null, () => {
    throw new Error('Native type 5 never calls its edit callback');
  });
  named(host.parent, 'Text')[0].parent.fire('dblclick');
  const pending = service.handleMessage(messages.take());
  controls(host.parent, 'text')[0].value = 'Edited';
  named(host.parent, 'OK')[0].fire('click');
  await pending;
  assert.equal(text.decodeAuto(source), 'Original');
  service.refresh(id);
  const output = {bytes: new Uint8Array(100), offset: 0};
  service.getValue(output, null, id, 0, 0);
  assert.equal(text.decodeAuto(output), 'Edited');
  source.bytes.set(text.encodeWide('Changed'));
  service.refresh(id);
  service.getValue(output, null, id, 0, 0);
  assert.equal(text.decodeAuto(output), 'Changed');
});

test('property tagged-ID OR collisions write output and keep the original window record', async () => {
  const {service, host, id, pointer} = await editor();
  const output = out();
  service.create(output, pointer('Second'), null, null, 80, 80);
  const second = new DataView(output.bytes.buffer).getUint32(0, true);
  assert.equal(id, 0xf8000001);
  assert.equal(second, 0xf8000003);
  assert.throws(() => service.create(output, pointer('Third'), null, null, 80, 80), /collision/);
  assert.equal(new DataView(output.bytes.buffer).getUint32(0, true), second);
  assert.equal(host.parent.children.length, 3);
  service.addButton(null, second, pointer('Still second'));
  assert.equal(named(host.parent.children[1], 'Still second').length, 1);
});

test('generated paints coalesce behind posted messages and disappear on window destruction', async () => {
  const {AokanaWindowMessages} =
    await import('../dist/engines/buriko/games/aokana/native/window-messages.js');
  const queue = new AokanaWindowMessages({setPhysicalKey() {}, setDequeuedKey() {}});
  queue.invalidate(1);
  queue.invalidate(1);
  queue.invalidate(2);
  queue.post({target: 1, message: 0x113, wParam: 7, lParam: 0});
  queue.post({target: 2, message: 0xf, wParam: 99, lParam: 0});
  queue.forgetTarget(2);
  assert.equal(queue.pending, 3);
  assert.equal(queue.take().message, 0x113);
  assert.equal(queue.take().wParam, 99);
  assert.deepEqual(queue.take(), {target: 1, message: 0xf, wParam: 0, lParam: 0});
  assert.equal(queue.take(), null);
});

function ansiDialogs() {
  const host = document(),
    text = new AokanaNativeText(),
    ansi = new AokanaAnsiUi(text);
  const transitions = [],
    errors = [];
  const dialog = new AokanaAnsiDialogs(
    host,
    host.parent,
    {
      async withNativeModal(operation) {
        transitions.push('enter');
        const result = await operation();
        transitions.push('leave');
        return result;
      },
      async show(message, title, flags) {
        errors.push([
          ansi.decode({bytes: message, offset: 0}),
          ansi.decode({bytes: title, offset: 0}),
          flags,
        ]);
        return 1;
      },
    },
    ansi,
    {value: 0x411},
  );
  const pointer = (value, capacity = 512) => {
    const bytes = new Uint8Array(capacity);
    bytes.set(ansi.encode(value));
    return {bytes, offset: 0};
  };
  return {host, text, ansi, dialog, transitions, errors, pointer};
}

test('ANSI host profile is separate from VM encoding and retains DBCS-straddling output bytes', () => {
  const {ansi, text} = ansiDialogs();
  text.selectMode(1);
  assert.deepEqual(
    [...ansi.getText('123456789日', 11)],
    [49, 50, 51, 52, 53, 54, 55, 56, 57, 0x93, 0],
  );
  assert.deepEqual([...ansi.getText('日', 2)], [0x93, 0]);
  assert.equal(ansi.insertion('', 0, 0, '日日日', 3, false), '日');
  assert.equal(ansi.insertion('', 0, 0, '日日日', 3, true), '日日日');
  assert.equal(ansi.insertion('AB日', 1, 2, '日日', 5, false), '日');
});

test('single ANSI form keeps Unicode control limits and native selection-blind numeric filtering', async () => {
  const {host, dialog, pointer, ansi, transitions} = ansiDialogs();
  const output = pointer('untouched');
  const pending = dialog.single(output, pointer('Title'), pointer('12'), -3);
  const input = controls(host.parent, 'text')[0];
  input.setSelectionRange(0, 2);
  input.fire('beforeinput', {inputType: 'insertText', data: '-'});
  assert.equal(input.value, '12');
  input.fire('beforeinput', {inputType: 'insertFromPaste', data: '日日日'});
  assert.equal(input.value, '日日日');
  named(host.parent, 'OK')[0].fire('click');
  assert.equal(await pending, 1);
  assert.equal(ansi.decode(output), '日日日');
  assert.deepEqual(transitions, ['enter', 'leave']);
});

test('pair ANSI form limits user insertion by bytes and writes the first output before a second fault', async () => {
  const {host, dialog, pointer, ansi} = ansiDialogs();
  const first = pointer('old');
  const pending = dialog.pair(
    0,
    null,
    {output: first, label: null, initial: null, limit: 3, numeric: 0},
    {output: null, label: null, initial: null, limit: 3, numeric: 0},
  );
  const inputs = controls(host.parent, 'text');
  inputs[0].setSelectionRange(0, 0);
  inputs[0].fire('beforeinput', {inputType: 'insertText', data: '日日'});
  assert.equal(inputs[0].value, '日');
  inputs[1].value = 'XYZ';
  named(host.parent, 'OK')[0].fire('click');
  await assert.rejects(pending, /null output/);
  assert.equal(ansi.decode(first), '日');
});

test('ANSI initial byte clipping can expand a dangling lead without applying the edit limit again', async () => {
  const {host, dialog, pointer, ansi} = ansiDialogs();
  const initial = pointer('A日');
  const output = pointer('old');
  const pending = dialog.single(output, null, initial, 2);
  assert.equal(controls(host.parent, 'text')[0].value, 'A・');
  named(host.parent, 'Cancel')[0].fire('click');
  assert.equal(await pending, 0);
  assert.equal(ansi.decode(output), 'old');
  assert.throws(() => ansi.initial(pointer('A'.repeat(1024), 1025), 0), /unterminated/);
});

test('name validation preserves prior successful writes and birthday February keeps its native 29 days', async () => {
  const {host, dialog, pointer, ansi, errors} = ansiDialogs();
  const outputs = ['姓', '名', '名', '名'].map((value) => pointer(value));
  const month = initial([0]),
    day = initial([30]);
  const pending = dialog.nameAndBirthday(...outputs, month, day);
  const inputs = controls(host.parent, 'text');
  inputs[0].value = '日本';
  inputs[1].value = 'ASCII';
  named(host.parent, 'OK')[0].fire('click');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ansi.decode(outputs[0]), '日本');
  assert.equal(ansi.decode(outputs[1]), '名');
  assert.deepEqual(errors, [['「名」に半角文字が含まれています', '入力エラー', 0x10]]);
  inputs[1].value = '';
  const selects = host.parent.children[0].children.flatMap((node) =>
    node.children.filter((child) => child.tagName === 'select'),
  );
  selects[0].selectedIndex = 1;
  selects[0].fire('change');
  assert.equal(selects[1].children.length, 29);
  assert.equal(selects[1].selectedIndex, 0);
  host.parent.children[0].fire('cancel');
  assert.equal(host.parent.children.length, 1);
  named(host.parent, 'OK')[0].fire('click');
  assert.equal(await pending, 1);
  assert.equal(ansi.decode(outputs[1]), '');
  assert.equal(new DataView(month.bytes.buffer).getInt32(0, true), 1);
  assert.equal(new DataView(day.bytes.buffer).getInt32(0, true), 0);
});

test('name validation faults on an odd dangling native lead after its written ANSI terminator', async () => {
  const {host, dialog, pointer} = ansiDialogs();
  const outputs = ['姓', '名', '名', '名'].map((value) => pointer(value));
  const pending = dialog.nameAndBirthday(...outputs, initial([0]), initial([0]));
  // CP932 single-byte FF maps to private-use F8F3; native 069a30 classifies FF as a lead.
  controls(host.parent, 'text')[0].value = '\uf8f3';
  named(host.parent, 'OK')[0].fire('click');
  await assert.rejects(pending, /uninitialized bytes/);
});

test('window identity validity follows actual main and child creation/destruction', async () => {
  const {AokanaWindowMessages} =
    await import('../dist/engines/buriko/games/aokana/native/window-messages.js');
  const queue = new AokanaWindowMessages({setPhysicalKey() {}, setDequeuedKey() {}});
  assert.equal(queue.hasTarget('main'), false);
  queue.createMainTarget();
  assert.equal(queue.hasTarget('main'), true);
  const child = queue.createTarget();
  assert.equal(queue.hasTarget(child), true);
  queue.forgetTarget(child);
  queue.forgetTarget('main');
  assert.equal(queue.hasTarget(child), false);
  assert.equal(queue.hasTarget('main'), false);
});

function childWindows(context) {
  const oldImage = globalThis.ImageData;
  globalThis.ImageData = class {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
  context.after(() => {
    globalThis.ImageData = oldImage;
  });
  const host = document(),
    text = new AokanaNativeText();
  const physical = new Map(),
    dequeued = new Map();
  const input = {
    setPhysicalKey(key, down) {
      physical.set(key, down);
    },
    setDequeuedKey(key, down) {
      dequeued.set(key, down);
    },
    asynchronousKeyState(key) {
      return physical.get(key) ? 0x8000 : 0;
    },
  };
  const messages = new AokanaWindowMessages(input);
  messages.createMainTarget();
  const compositor = new AokanaBitmapCompositor();
  compositor.defaultFormat = 1;
  const fonts = new AokanaNativeFonts(text, {}),
    allocator = new AokanaDistributedAllocator(1);
  const surfaces = new AokanaSurfaces(fonts, compositor, allocator);
  const desktop = host.createElement('canvas'),
    transitions = [],
    clipboard = [];
  const service = new AokanaChildWindows(
    host,
    host.parent,
    {
      clipboard: {
        async writeText(value) {
          clipboard.push(value);
        },
      },
    },
    text,
    surfaces,
    compositor,
    new AokanaBitmapText(fonts, compositor),
    {
      transition(value) {
        transitions.push(value);
      },
    },
    messages,
    new AokanaKeyboardMessages(messages),
    {frameWidth: 2, frameHeight: 22, verticalScrollbarWidth: 15, horizontalScrollbarHeight: 16},
    text.encodeWide('Default title'),
    desktop,
  );
  service.initialize();
  const output = out(),
    title = {bytes: text.encodeWide('Child'), offset: 0};
  const create = (flags = 0) => {
    const result = service.create(output, title, 10, 20, 32, 32, flags);
    return {result, id: new DataView(output.bytes.buffer).getUint32(0, true)};
  };
  return {
    host,
    text,
    service,
    messages,
    compositor,
    surfaces,
    desktop,
    transitions,
    clipboard,
    physical,
    dequeued,
    create,
    output,
    title,
  };
}

test('child slot validity, creation dimensions and move geometry retain their distinct native paths', (context) => {
  const {service, host, create, output, title} = childWindows(context);
  assert.equal(service.getScrollProperty(output, 0xf8000007, 0), 0);
  assert.equal(service.fill(0xf8000007, 0), 1);
  assert.throws(() => service.getPosition(output, 0xf8000007), /uninitialized RECT/);
  assert.equal(service.create(null, null, 0, 0, 31, 32, 0), 0x80000001);
  const {id, result} = create(3);
  assert.equal(result, 0);
  assert.equal(id, 0xf8000000);
  const panel = host.parent.children[0];
  assert.equal(panel.style.width, '49px');
  assert.equal(panel.style.height, '70px');
  service.setPosition(id, -10, 70);
  assert.equal(panel.style.width, '34px');
  assert.equal(panel.style.height, '54px');
  service.getPosition(output, id);
  assert.deepEqual(event(output), [-10, 70]);
  for (let index = 1; index < 8; index++) assert.equal(create().id, 0xf8000000 + index);
  assert.equal(service.create(null, title, 0, 0, 32, 32, 0), 0x80000002);
});

test('child closing needs script permission and show/paint lifetimes preserve the native visibility integer', async (context) => {
  const {service, host, create, messages, transitions} = childWindows(context);
  const {id} = create();
  const panel = host.parent.children[0];
  assert.equal(panel.hidden, true);
  service.show(id, 7);
  service.show(id, 1);
  const paint = messages.take();
  assert.equal(paint.message, 0xf);
  await service.handleMessage(paint);
  const canvas = panel.children[1].children[0];
  assert.equal(canvas.draws.length, 1);
  named(host.parent, '×')[0].fire('click');
  await service.handleMessage(messages.take());
  assert.equal(host.parent.children.length, 1);
  assert.equal(messages.hasTarget(paint.target), true);
  service.close(id);
  assert.equal(host.parent.children.length, 0);
  assert.equal(messages.hasTarget(paint.target), false);
  assert.deepEqual(transitions, [true, false]);
  assert.equal(service.getScrollProperty(out(), id, 0), 0);
});

test('child WndProc forwards key message parameters unchanged but consumes Ctrl+C only on keydown', async (context) => {
  const {service, create, messages, text, physical, clipboard} = childWindows(context);
  const {id} = create();
  service.show(id, 1);
  const paint = messages.take();
  const key = {target: paint.target, message: 0x100, wParam: 0x41, lParam: 0xfedcba9876543210n};
  await service.handleMessage(key);
  assert.deepEqual(messages.take(), {...key, target: 'main'});
  service.setClipboard(id, {bytes: text.encodeWide('Copied'), offset: 0});
  physical.set(0x11, true);
  await service.handleMessage({...key, wParam: 0x43});
  assert.deepEqual(clipboard, ['Copied']);
  assert.equal(messages.take(), null);
  await service.handleMessage({...key, message: 0x101, wParam: 0x43});
  assert.equal(messages.take().message, 0x101);
  await service.handleMessage({...key, message: 0x104});
  assert.equal(messages.take(), null);
});

test('child failed HWND creation retains its bitmap and later GetDC(NULL) draws to the real desktop canvas', (context) => {
  const {service, host, create, desktop, output} = childWindows(context);
  host.parent.append = () => {
    throw new DOMException('Synthetic unavailable host window', 'InvalidStateError');
  };
  const {id, result} = create();
  assert.equal(result, 0);
  assert.throws(() => service.getPosition(output, id), /uninitialized RECT/);
  assert.equal(service.fill(id, 0x112233), 1);
  assert.deepEqual([...desktop.draws[0].image.data.slice(0, 4)], [0x11, 0x22, 0x33, 255]);
});

test('child scroll callbacks update stored positions only after FIFO dispatch and retain 16-bit thumb packing', async (context) => {
  const {service, host, create, messages, output} = childWindows(context);
  const {id} = create(3);
  service.setScrollProperty(id, 0, (2 << 16) | 20);
  service.setScrollProperty(id, 1, (3 << 16) | 10);
  named(host.parent, '▶')[0].fire('click');
  service.getScrollProperty(output, id, 2);
  assert.equal(event(output)[0], 0);
  const scroll = messages.take();
  await service.handleMessage(scroll);
  service.getScrollProperty(output, id, 2);
  assert.equal(event(output)[0], 1);
  await service.handleMessage({...scroll, message: 0x115, wParam: (0xffff0000 | 5) >>> 0});
  service.getScrollProperty(output, id, 3);
  assert.equal(event(output)[0], 65535);
  await assert.rejects(
    service.handleMessage({...scroll, message: 0x20a, wParam: 120 << 16}),
    /uninitialized native SCROLLINFO/,
  );
});

test('reinitializing child globals preserves orphan HWNDs and later record-dependent dispatch faults', async (context) => {
  const {service, host, create, messages} = childWindows(context);
  const {id} = create();
  service.show(id, 1);
  const paint = messages.take();
  service.initialize();
  assert.equal(host.parent.children.length, 1);
  assert.equal(messages.hasTarget(paint.target), true);
  await assert.rejects(service.handleMessage(paint), /missing native window record/);
  service.dispose();
  assert.equal(host.parent.children.length, 1);
});

test('B0 property bindings preserve static DWORDs, aliasing output stores and distinct error translations', async () => {
  const {service, id, text} = await editor(),
    vm = vmSlots(createGroupB0Properties(service));
  assert.equal(vm.slots.size, 11);
  vm.write(64, text.encodeWide('Field'));
  await vm.run(0x6c, [128, id, 0, 64, 1, 0xffffffff]);
  assert.equal(vm.pop(), 0);
  assert.equal(vm.view.getUint32(128, true), 0);
  await vm.run(0x6f, [160, 160, id, 0, 0]);
  assert.equal(vm.pop(), 0);
  // Value is stored first; a coincident type output then overwrites that same DWORD.
  assert.equal(vm.view.getUint32(160, true), 1);
  await vm.run(0x6f, [0, 0, id, 0, 99]);
  assert.equal(vm.pop(), 3);
  await vm.run(0x6c, [0, id, 99, 64, 0, 9]);
  assert.equal(vm.pop(), 2);
  await vm.run(0x68, [0, 0, 0]);
  assert.equal(vm.pop(), 0xffffffff);
  await vm.run(0x67, [128, id]);
  assert.equal(vm.pop(), 6);
});

test('B0 child bindings keep validation precedence, native IDs and paired position pushes', async (context) => {
  const {service, text, host} = childWindows(context),
    failures = [];
  const errors = {
    async threadFatal(_thread, _diagnostics, bytes) {
      failures.push(text.decodeCp932(bytes).replace(/\0$/, ''));
      throw new Error('native fatal');
    },
  };
  const vm = vmSlots(createGroupB0Children(service, errors));
  assert.equal(vm.slots.size, 14);
  vm.write(1, text.encodeWide('Bound child'));
  await vm.run(0x12, [1, -7, 9, 32, 32, 3]);
  const id = vm.pop();
  assert.equal(id, 0xf8000000);
  await vm.run(0x17, [id]);
  assert.equal(vm.pop(), 9);
  assert.equal(vm.pop(), 0xfffffff9);
  assert.equal(host.parent.children[0].style.width, '49px');
  await assert.rejects(vm.run(0x19, [0xffffffff, 0, 0, 0x4000, 0xfff, 257]), /native fatal/);
  assert.match(failures.at(-1), /ビットマップ番号/);
  await assert.rejects(vm.run(0x19, [0xffffffff, 0, 0, 0, 0xfff, 257]), /native fatal/);
  assert.match(failures.at(-1), /エフェクトモード/);
  await vm.run(0x1e, [id, 1, 5]);
  assert.equal(vm.pop(), 0);
  await vm.run(0x1f, [100, id, 1]);
  assert.equal(vm.pop(), 0);
  assert.equal(vm.view.getInt32(100, true), 5);
});

test('B0 dialog binding enters the real single form and translates its accepted output', async () => {
  const {host, dialog, text} = ansiDialogs();
  const dialogs = dialog.dialogs,
    product = new AokanaProductKeyDialog(host, host.parent, dialogs, text);
  const settings = new AokanaModelessSettings(host, host.parent, dialogs);
  const definitions = createGroupB0Dialogs(
    dialogs,
    dialog,
    product,
    new AokanaSelectionDialog(dialogs, text),
    settings,
  );
  const vm = vmSlots(definitions);
  assert.equal(vm.slots.size, 14);
  vm.write(64, text.encodeWide('Initial'));
  vm.write(96, text.encodeWide('Caption'));
  const pending = vm.run(0x84, [128, 96, 64, 3]);
  const input = controls(host.parent, 'text')[0];
  assert.equal(input.value, 'Ini');
  input.value = '123';
  named(host.parent, 'OK')[0].fire('click');
  await pending;
  assert.equal(vm.pop(), 1);
  assert.equal(text.decodeAuto({bytes: vm.memory.globalMemory, offset: 128}), '123');
  await vm.run(0xa0, [128, 99, 0]);
  assert.equal(vm.pop(), 0);
  await vm.run(0xa3, [0, 0]);
  assert.equal(vm.pop(), 0xffffffff);
});

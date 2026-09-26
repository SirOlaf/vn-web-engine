import test from 'node:test';
import assert from 'node:assert/strict';
import {deviceServiceFixture} from './aokana-device-service-fixture.mjs';
import {BurikoNativeCursor} from '../dist/engines/buriko/native/engine-dialogs.js';
import {
  BurikoCursorShapes,
  readBurikoCursorResource,
} from '../dist/engines/buriko/native/cursor-shapes.js';
import {createGroup80CursorShapes} from '../dist/engines/buriko/native/group-80-cursor-shapes.js';
import {BurikoMainWindowMessageReceiver} from '../dist/engines/buriko/native/main-window-messages.js';
import {BurikoWindowMessages as Waits} from '../dist/engines/buriko/native/procedure.js';
import {BurikoKnobDisplays} from '../dist/engines/buriko/native/knob-displays.js';
import {BurikoBpThread, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';

// Ordinary synthetic PE directory and initialized cursor pixels; no executable is run.
function dib({width = 32, height = 32, depth = 24, x = 9, y = 2, core = false} = {}) {
  const header = core ? 12 : 40,
    colors = depth <= 8 ? 1 << depth : 0;
  const b = Buffer.alloc(
    4 +
      header +
      colors * (core ? 3 : 4) +
      (Math.ceil((width * depth) / 32) * 4 + Math.ceil(width / 32) * 4) * height,
  );
  b.writeUInt16LE(x, 0);
  b.writeUInt16LE(y, 2);
  b.writeUInt32LE(header, 4);
  if (core) {
    b.writeUInt16LE(width, 8);
    b.writeUInt16LE(height * 2, 10);
    b.writeUInt16LE(1, 12);
    b.writeUInt16LE(depth, 14);
  } else {
    b.writeInt32LE(width, 8);
    b.writeInt32LE(height * 2, 12);
    b.writeUInt16LE(1, 16);
    b.writeUInt16LE(depth, 18);
    b.writeUInt32LE(b.length - 44 - colors * 4, 24);
  }
  b.fill(0x5a, 4 + header + colors * (core ? 3 : 4));
  return b;
}
function group(images) {
  const b = Buffer.alloc(6 + images.length * 14);
  b.writeUInt16LE(2, 2);
  b.writeUInt16LE(images.length, 4);
  images.forEach(({id = 1, bytes, width = 32, height = 32, depth = 24, png = false}, i) => {
    const p = 6 + i * 14;
    b.writeUInt16LE(width, p);
    b.writeUInt16LE(height * (png ? 1 : 2), p + 2);
    b.writeUInt16LE(1, p + 4);
    b.writeUInt16LE(depth, p + 6);
    b.writeUInt32LE(bytes.length, p + 8);
    b.writeUInt16LE(id, p + 12);
  });
  return b;
}
function fixture(entries, {plus = true} = {}) {
  const scratch = Buffer.alloc(1024 * 1024),
    root = 0x200,
    rva = 0x1000,
    leaves = [],
    directories = [];
  let end = 0;
  const alloc = (size) => {
    const p = end;
    end = (end + size + 3) & ~3;
    return p;
  };
  function tree(items, level) {
    const field = ['type', 'id', 'language'][level],
      groups = new Map();
    for (const item of items) {
      const key = item[field];
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    const keys = [...groups.keys()].sort((a, b) =>
      typeof a === typeof b ? (a < b ? -1 : 1) : typeof a === 'string' ? -1 : 1,
    );
    const p = alloc(16 + keys.length * 8);
    directories.push(root + p);
    scratch.writeUInt16LE(keys.filter((k) => typeof k === 'string').length, root + p + 12);
    scratch.writeUInt16LE(keys.filter((k) => typeof k === 'number').length, root + p + 14);
    keys.forEach((key, i) => {
      const entry = root + p + 16 + i * 8;
      if (typeof key === 'string') {
        const text = Buffer.from(key, 'utf16le'),
          name = alloc(2 + text.length);
        scratch.writeUInt16LE(text.length / 2, root + name);
        text.copy(scratch, root + name + 2);
        scratch.writeUInt32LE((name | 0x80000000) >>> 0, entry);
      } else scratch.writeUInt32LE(key, entry);
      if (level < 2)
        scratch.writeUInt32LE((tree(groups.get(key), level + 1) | 0x80000000) >>> 0, entry + 4);
      else {
        assert.equal(groups.get(key).length, 1);
        const item = groups.get(key)[0],
          data = alloc(16),
          payload = alloc(item.bytes.length);
        scratch.writeUInt32LE(data, entry + 4);
        scratch.writeUInt32LE(rva + payload, root + data);
        scratch.writeUInt32LE(item.bytes.length, root + data + 4);
        item.bytes.copy(scratch, root + payload);
        leaves.push({...item, entry, data: root + data, payload: root + payload});
      }
    });
    return p;
  }
  tree(entries, 0);
  const optional = 0x98,
    optionalSize = plus ? 240 : 224,
    directory = optional + (plus ? 112 : 96),
    section = optional + optionalSize;
  scratch.write('MZ');
  scratch.writeUInt32LE(0x80, 60);
  scratch.write('PE\0\0', 0x80);
  scratch.writeUInt16LE(1, 0x86);
  scratch.writeUInt16LE(optionalSize, 0x94);
  scratch.writeUInt16LE(plus ? 0x20b : 0x10b, optional);
  scratch.writeUInt32LE(root, optional + 60);
  scratch.writeUInt32LE(16, directory - 4);
  scratch.writeUInt32LE(rva, directory + 16);
  scratch.writeUInt32LE(end, directory + 20);
  scratch.write('.rsrc', section);
  scratch.writeUInt32LE(end + 0x1000, section + 8);
  scratch.writeUInt32LE(rva, section + 12);
  scratch.writeUInt32LE(end, section + 16);
  scratch.writeUInt32LE(root, section + 20);
  return {
    bytes: Buffer.from(scratch.subarray(0, root + end)),
    leaves,
    directories,
    directory,
    section,
  };
}
function simple(options = {}, peOptions) {
  const bytes = dib(options),
    metadata = {bytes, ...options};
  return fixture(
    [
      {type: 1, id: 1, language: 1041, bytes},
      {type: 12, id: 106, language: 1041, bytes: group([metadata])},
    ],
    peOptions,
  );
}

test('80:67 shares resource-backed cursor selection, client messages and physical visibility', () => {
  const s = deviceServiceFixture(),
    listeners = new Map();
  s.canvas.addEventListener = (name, listener) => listeners.set(name, listener);
  s.canvas.removeEventListener = (name) => listeners.delete(name);
  const resource = readBurikoCursorResource(
      simple({width: 32, height: 32, depth: 8, x: 0, y: 0}).bytes,
    ),
    cur = new DataView(resource.buffer, resource.byteOffset, resource.byteLength);
  assert.equal(resource.length, 2238);
  assert.equal(cur.getUint16(2, true), 2);
  assert.equal(cur.getUint16(4, true), 1);
  assert.equal(resource[6], 32);
  assert.equal(resource[7], 32);
  assert.equal(cur.getUint16(10, true), 0);
  assert.equal(cur.getUint16(12, true), 0);
  const physical = new BurikoNativeCursor(s.canvas),
    shapes = new BurikoCursorShapes(physical, s.messages, resource),
    waits = new Waits(),
    knobs = new BurikoKnobDisplays(s.manager, s.input, s.notifications);
  new BurikoMainWindowMessageReceiver(
    s.messages,
    waits,
    s.input,
    s.notifications,
    s.controller.host,
    knobs,
    s.controller,
    shapes,
  );
  const [slot] = createGroup80CursorShapes(shapes, {
    threadFatal() {
      assert.fail('ordinary valid cursor selection');
    },
  });
  assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x80][0x67]);
  const thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 8,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    memory = new BurikoBpMemory(new Uint8Array(32));
  for (const index of [0, 1, 2, 4, 0]) {
    push32(thread, index);
    assert.equal(slot.execute({thread, memory, diagnostics: {}}), 0);
    assert.equal(thread.stackIndex, 0);
    listeners.get('pointermove')();
    assert.equal(s.canvas.style.cursor, 'default');
  }
  physical.setVisible(0);
  listeners.get('pointerenter')();
  assert.equal(s.canvas.style.cursor, 'none');
  physical.setVisible(1);
  assert.equal(s.canvas.style.cursor, 'default');
  assert.equal(s.messages.send('main', 0x20, 0, 0x02000001), 1);
  shapes.dispose();
  assert.equal(listeners.size, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoImportedTextMaps} from '../dist/engines/buriko/native/imported-text-maps.js';
import {createGroup81ImportedText} from '../dist/engines/buriko/native/group-81-imported-text.js';
import {BurikoNativeText, textBytes} from '../dist/engines/buriko/native/text.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';

const pointer = (bytes) => ({bytes, offset: 0});
function encodeImport(text, groups) {
  const bytes = [],
    word = (value) =>
      bytes.push(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, value >>> 24),
    string = (value) => bytes.push(...text.encodeWide(value, 1));
  word(groups.length);
  for (const [name, entries] of groups) {
    string(name);
    word(entries.length);
    for (const [key, value] of entries) {
      string(key);
      string(value);
    }
  }
  return Uint8Array.from(bytes);
}

test('imported maps retain shared inner references and convert each lookup name to UTF8', () => {
  const text = new BurikoNativeText(),
    maps = new BurikoImportedTextMaps(text);
  const first = encodeImport(text, [
    [
      '項目',
      [
        ['名前', '青'],
        ['count', '2'],
      ],
    ],
    ['other', [['entry', 'retained']]],
  ]);
  assert.equal(maps.import(pointer(first), first.length), true);
  const group = pointer(text.encodeWide('項目', 0)),
    key = pointer(text.encodeWide('名前', 0));
  assert.deepEqual(textBytes(maps.lookup(group, key), true), text.encodeWide('青', 1));
  const second = encodeImport(text, [['third', [['entry', 'added']]]]);
  assert.equal(maps.import(pointer(second), second.length), true);
  assert.deepEqual(textBytes(maps.lookup(group, key), true), text.encodeWide('青', 1));
  const added = maps.lookup(
    pointer(text.encodeWide('third', 0)),
    pointer(text.encodeWide('entry', 0)),
  );
  assert.deepEqual(textBytes(added), new TextEncoder().encode('added'));
  maps.clear();
  assert.equal(maps.lookup(group, key), null);
});

test('81 D8/DA preserve import and output stack order, raw UTF8 copying and the length query', () => {
  const text = new BurikoNativeText(),
    maps = new BurikoImportedTextMaps(text);
  const definitions = createGroup81ImportedText(maps);
  assert.equal(definitions.length, 2);
  for (const slot of definitions)
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x81][slot.secondary]);
  const thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 8,
      moduleCapacity: 2048,
      frameCapacity: 0,
    }),
    memory = new BurikoBpMemory(new Uint8Array(1)),
    context = {thread, memory};
  const put = (address, bytes) => {
    const output = memory.resolve(thread, address);
    output.bytes.set(bytes, output.offset);
  };
  const data = encodeImport(text, [['項目', [['名前', '青']]]]);
  put(0x10000000, data);
  put(0x10000300, text.encodeWide('項目', 0));
  put(0x10000380, text.encodeWide('名前', 0));
  const call = (index, args) => {
    args.forEach((value) => push32(thread, value));
    assert.equal(definitions[index].execute(context), 0);
    return pop32(thread);
  };
  assert.equal(call(0, [0x10000000, data.length]), 1);
  assert.equal(call(1, [0x10000400, 0x10000300, 0x10000380]), 3);
  assert.deepEqual(textBytes(memory.resolve(thread, 0x10000400), true), text.encodeWide('青', 1));
  assert.equal(call(1, [0, 0x10000300, 0x10000380]), 3);
  assert.equal(call(0, [0, 0]), 1);
  assert.equal(call(1, [0x10000400, 0x10000300, 0x10000380]), 0);
  assert.equal(thread.stackIndex, 0);
});

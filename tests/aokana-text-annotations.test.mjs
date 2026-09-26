import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {
  BurikoRubyAnnotations,
  burikoTextCodes,
} from '../dist/engines/buriko/native/text-annotations.js';
import {BurikoTextLayoutState} from '../dist/engines/buriko/native/text-layout-state.js';
import {createGroup91TextSettings} from '../dist/engines/buriko/native/group-91-text-settings.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';

const pointer = (bytes) => ({bytes, offset: 0});
function setup() {
  const text = new BurikoNativeText();
  const surfaces = new BurikoSurfaces(
    new BurikoNativeFonts(text),
    new BurikoBitmapCompositor(),
    new BurikoDistributedAllocator(1),
  );
  const annotations = new BurikoRubyAnnotations(text);
  const value = (input, mode = 1) => pointer(text.encodeWide(input, mode));
  return {text, surfaces, annotations, value};
}
function keys(text, annotations) {
  const output = [];
  for (let entry = annotations.first; entry !== null; entry = entry.next)
    output.push(text.decodeAuto(pointer(entry.key)));
  return output;
}

test('ruby imports normalize owned text and order persistent keys by byte length with later ties first', () => {
  const {text, annotations, value} = setup();
  assert.equal(annotations.import(value('海\\うみ\n海外\\かいがい\n空\\そら', 0)), 1);
  assert.deepEqual(keys(text, annotations), ['海外', '空', '海']);
  const key = annotations.query(value('海')).key;
  annotations.add(value('海'), value('うみべ', 0));
  const updated = annotations.query(value('海'));
  assert.equal(updated.key, key);
  assert.deepEqual(keys(text, annotations), ['海外', '空', '海']);
  assert.equal(updated.readingWide, 'うみべ');
  assert.deepEqual(Array.from(updated.codes), [0x3046, 0x307f, 0x3079]);
  assert.deepEqual(
    [updated.keyByteLength, updated.keyWideLength, updated.readingLength],
    [4, 1, 3],
  );
  assert.equal(updated.next, null);
  assert.equal(annotations.import(value('')), 1);
  assert.equal(annotations.import(null), 0);
});

test('one-use annotations retain insertion order, consume once, and remove independently of persistent keys', () => {
  const {annotations, value, text} = setup();
  annotations.add(value('海'), value('persistent'));
  annotations.add(value('海'), value('first'), 1);
  annotations.add(value('海'), value('second'), 2);
  assert.deepEqual(
    [annotations.first.oneUse, annotations.first.next.oneUse, annotations.first.next.next.oneUse],
    [1, 2, 0],
  );
  const matched = annotations.matchPrefix(value('海に'), true);
  assert.equal(matched.wide, '海');
  assert.equal(annotations.first.used, 1);
  assert.notEqual(matched.key, annotations.first.key);
  assert.equal(annotations.remove(value('海'), 1), 1);
  assert.equal(annotations.query(value('海')).readingWide, 'second');
  assert.equal(annotations.matchPrefix(value('海に')).wide, null);
  assert.equal(annotations.first.used, 1);
  assert.equal(annotations.remove(value('海'), 1), 1);
  assert.equal(annotations.query(value('海')).readingWide, 'persistent');
  assert.equal(annotations.matchPrefix(value('海に'), true).wide, '海');
  assert.equal(annotations.first.used, 0);
  assert.deepEqual(keys(text, annotations), ['海']);
  annotations.addInlineWide('空', 'そら');
  annotations.addInlineWide('雲', 'くも');
  assert.equal(text.decodeAuto(pointer(annotations.matchEncodedPrefix(value('雲と空', 0)))), '雲');
  annotations.clearInline();
  assert.deepEqual(keys(text, annotations), ['海']);
});

test('persistent extraction follows source order, skips each matched word and feeds a separate invocation context', () => {
  const {text, surfaces, value} = setup();
  const state = new BurikoTextLayoutState(surfaces),
    persistent = state.annotations;
  persistent.add(value('海'), value('うみ'));
  persistent.add(value('海外'), value('かいがい'));
  const output = pointer(new Uint8Array(256));
  assert.equal(persistent.extract(output, value('海外と海、海外。', 0)), 3);
  assert.equal(text.decodeAuto(output), '海外\\かいがい\n海\\うみ\n海外\\かいがい\n');
  const invocation = new BurikoRubyAnnotations(text);
  assert.equal(invocation.import(output), 1);
  assert.deepEqual(keys(text, invocation), ['海外', '海']);
  assert.notEqual(invocation.query(value('海')).reading, persistent.query(value('海')).reading);
  invocation.clear();
  assert.equal(invocation.first, null);
  assert.deepEqual(keys(text, persistent), ['海外', '海']);
  const unchanged = value('unchanged');
  assert.equal(persistent.extract(unchanged, value('空')), 0);
  assert.equal(text.decodeAuto(unchanged), 'unchanged');
});

test('ruby lookup compares supplied bytes while removal converts them, and ordinary BMP codes retain native counts', () => {
  const {text, annotations, value} = setup();
  annotations.add(value('海', 0), value('Aあｶ', 0));
  assert.equal(annotations.query(value('海', 0)), null);
  const entry = annotations.query(value('海'));
  assert.equal(entry.readingLength, 3);
  assert.deepEqual(Array.from(entry.codes), [65, 0x3042, 0xff76]);
  assert.equal(entry.reading, annotations.first.reading);
  const codes = new Uint32Array(3);
  assert.equal(burikoTextCodes(text, value('Aあｶ', 0), codes), 3);
  assert.deepEqual(Array.from(codes), [65, 0x3042, 0xff76]);
  assert.equal(annotations.remove(value('海', 0)), 1);
  assert.equal(annotations.first, null);
});

test('all three text settings wrappers preserve native stack order and share the actual persistent registry', async () => {
  const {text, surfaces, value} = setup(),
    state = new BurikoTextLayoutState(surfaces);
  const definitions = createGroup91TextSettings(state, {
    threadFatal() {
      assert.fail('ordinary text settings should not raise a thread error');
    },
  });
  assert.deepEqual(
    definitions.map((slot) => slot.secondary),
    [0x94, 0x96, 0x98],
  );
  for (const slot of definitions)
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x91][slot.secondary]);
  const thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    memory = new BurikoBpMemory(new Uint8Array(512));
  memory.globalMemory.set(value('海', 0).bytes, 16);
  memory.globalMemory.set(value('うみ', 0).bytes, 64);
  memory.globalMemory.set(value('空\\そら\n海\\うみべ', 0).bytes, 128);
  async function call(slot, args, output = false) {
    const before = thread.stackIndex;
    for (const arg of args) push32(thread, arg);
    assert.equal(
      await definitions
        .find((definition) => definition.secondary === slot)
        .execute({thread, memory}),
      0,
    );
    assert.equal(thread.stackIndex, before + Number(output));
    return output ? pop32(thread) : undefined;
  }
  await call(0x94, [16, 64]);
  assert.equal(state.annotations.query(value('海')).readingWide, 'うみ');
  assert.equal(await call(0x96, [128], true), 1);
  assert.equal(state.annotations.query(value('海')).readingWide, 'うみべ');
  await call(0x98, [30, 0, 2, 50, 3, 4]);
  assert.deepEqual(
    [
      state.field1C9100,
      state.field1C90E8,
      state.field1D1E48,
      state.field1C90EC,
      state.lineStartOffset,
      state.field1D1E4C,
    ],
    [30, 1, 2, 50, 3, 4],
  );
  await call(0x94, [16, 0]);
  assert.deepEqual(keys(text, state.annotations), ['空']);
  await call(0x94, [0, 0]);
  assert.equal(state.annotations.first, null);
  assert.equal(await call(0x96, [0], true), 0);
});

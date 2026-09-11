import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runtime, literal} from './sc3-fixtures.mjs';

const glyph = (id) => [128 | (id >> 8), id & 255];
async function choiceRuntime(code, text = [255], message = text) {
  const script = Buffer.alloc(1024);
  script.write('SC3\0');
  script.writeUInt32LE(32, 4);
  script.writeUInt32LE(32, 8);
  script.writeUInt32LE(64, 12);
  script.writeUInt32LE(512, 32);
  script.set(code, 64);
  script.set(text, 512);
  const mes = Buffer.alloc(1024);
  mes.write('MES\0');
  mes.writeUInt32LE(1, 8);
  mes.writeUInt32LE(64, 12);
  mes.writeInt32LE(17, 16);
  mes.writeUInt32LE(0, 20);
  mes.set(message, 64);
  const vm = runtime([]);
  vm.assets.script = async () => script;
  vm.assets.messages = async () => mes;
  await vm.boot();
  const s = vm.state;
  s.put(0x20ddf0, 25);
  [0, 12, 8, 0, 0, 160, 0, 0, 28, 28, 180, 420, 0, 0, 32, 32, 16, 16, 8, 4, 0, 0, 0, 0].forEach(
    (v, i) => s.put(0x7fbea0 + i * 2, v, 2),
  );
  return {vm, s};
}

test('scene-choice selector zero checkpoints when required and fully resets native choice state', async () => {
  const {vm, s} = await choiceRuntime([1, 0x12, 0, 0x34, 0x12, ...literal(-9), 0, 3]);
  s.setVariable(0x4330 / 4, 123);
  s.setVariable(0x4340 / 4, 456);
  s.setVariable(0x20f0 / 4, 99);
  s.put(0x5b10b0, 0);
  s.put(0x660ff0, 7);
  s.put(0x719a08, 8);
  s.put(0x7686e0, 9);
  s.put(0x660ff4, 10);
  s.put(0x768710, 11);
  s.put(0x5b10ac + 7 * 0x11984, 3);
  for (let i = 0; i < 30; i++) {
    s.put(0x80eb20 + i * 8, 0x1000 + i);
    s.put(0x80f250 + i * 8, 0x2000 + i);
  }
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.pc(0), 64 + 2 + 1 + 2 + literal(0).length);
  assert.equal(s.get(0x20d3cc), 0x1234);
  assert.equal(s.get(0xc491e0), 1);
  assert.equal(s.get(0xc491f0), 456);
  assert.equal(s.get(0xc491f4), 123);
  assert.equal(s.flags[0x96] & 0x40, 0x40);
  assert.equal(s.flags[0xa0] & 0x20, 0x20);
  assert.equal(s.variable(0x2150 / 4), -9);
  assert.equal(s.variable(0x20f0 / 4), 0);
  assert.equal(s.get(0x768710), -1);
  assert.equal(s.get(0x660ff0), 0);
  assert.equal(s.get(0x719a08), 0);
  assert.equal(s.get(0x7686e0), 0);
  assert.equal(s.get(0x660ff4), 0);
  assert.equal(s.get(0x5b10ac + 7 * 0x11984), 0);
  for (let i = 0; i < 30; i++) {
    assert.equal(s.get(0x80eb20 + i * 8), 0);
    assert.equal(s.get(0x80f250 + i * 8), 0);
  }
});

test('scene-choice direct rows use transient centered layout, tag metadata and row-marked packed glyphs', async () => {
  const text = [...glyph(400), ...glyph(401), 255],
    {vm, s} = await choiceRuntime([1, 0x12, 1, 0, 0, 0, 3], text);
  s.put(0x660ff0, 2);
  s.put(0x719a08, 7);
  s.put(0x62c348, 4);
  s.put(0x63a480, 2, 1);
  s.put(0x63a481, 1, 1);
  s.put(0x63a482, 2, 1);
  s.put(0x63a483, 3, 1);
  assert.equal(vm.runContext(0), 'yield');
  const width = s.get(0x80eb20 + 2 * 8),
    height = s.get(0x80eb24 + 2 * 8);
  assert.ok(width > 0);
  assert.ok(height > 0);
  assert.equal(s.get(0x80cf70 + 2 * 4), 25);
  assert.equal(s.get(0x80f250 + 2 * 8), (640 - (width >>> 1)) >>> 0);
  assert.equal(s.get(0x7686e0), width);
  assert.equal(s.get(0x737910 + 2 * 4), 0);
  assert.equal(s.get(0x732a20 + 2 * 4), 7);
  assert.equal(s.get(0x660ff0), 3);
  assert.equal(s.get(0x719a08), 8);
  assert.equal(s.get(0x5b10ac + 7 * 0x11984), 6);
  assert.equal(s.bytes(0x5bf1e4 + 7 * 0x11984 + 4, 2)[0], 2);
  assert.equal(s.bytes(0x5bf1e4 + 7 * 0x11984 + 4, 2)[1], 2);
  assert.deepEqual([...s.bytes(0x63d360, 4)], [255, 0, 255, 0]);
  assert.ok(s.view(0x80ce80 + 2 * 8, 8).getBigUint64(0, true) > 0xffffffffn);
});

test('scene-choice conditional and MES selectors preserve native inclusion and ordinal rules', async () => {
  const falseChoice = await choiceRuntime(
    [1, 0x12, 2, 0, 0, ...literal(0), 0, 3],
    [...glyph(400), 255],
  );
  falseChoice.s.put(0x660ff0, 4);
  falseChoice.s.put(0x719a08, 9);
  assert.equal(falseChoice.vm.runContext(0), 'yield');
  assert.equal(falseChoice.s.get(0x660ff0), 4);
  assert.equal(falseChoice.s.get(0x719a08), 10);
  assert.equal(falseChoice.s.get(0x5b10ac + 7 * 0x11984), 0);
  const mesChoice = await choiceRuntime(
    [1, 0x12, 129, ...literal(17), 0, 3],
    [255],
    [...glyph(402), 255],
  );
  mesChoice.s.put(0x660ff0, 1);
  assert.equal(mesChoice.vm.runContext(0), 'yield');
  assert.equal(mesChoice.s.get(0x660ff0), 2);
  assert.equal(mesChoice.s.get(0x5b10ac + 7 * 0x11984), 1);
  assert.equal(mesChoice.s.get(0x737910 + 4), 0x11e0);
  const invalid = await choiceRuntime([1, 0x12, 3, 0, 0]);
  assert.throws(() => invalid.vm.runContext(0), /uninitialized native stack/);
});

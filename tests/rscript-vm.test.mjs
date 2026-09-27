import test from 'node:test';
import assert from 'node:assert/strict';
import {parseGsc} from '../dist/formats/rscript/gsc.js';
import {RSCRIPT_1_11_LAYOUTS} from '../dist/engines/rscript/vm/layouts.js';
import {MsvcRandom, RScriptInterpreter} from '../dist/engines/rscript/vm/interpreter.js';
import {RScriptMemory, Scene} from '../dist/engines/rscript/memory.js';
import {RScriptBitsetStore} from '../dist/engines/rscript/bitset-store.js';
import {
  decodeSlotHeader,
  decodeSlotSave,
  decodeSystemSave,
  encodeSlotSave,
  encodeSystemSave,
} from '../dist/engines/rscript/saves.js';
import {gsc} from './rscript-fixtures.mjs';

/** A tiny assembler for GSC code: expressions carry operand modes in the opcode. */
class Code {
  bytes = [];
  fixups = [];
  labels = new Map();
  get offset() {
    return this.bytes.length;
  }
  u16(v) {
    this.bytes.push(v & 0xff, (v >> 8) & 0xff);
    return this;
  }
  u32(v) {
    return this.u16(v & 0xffff).u16(v >>> 16);
  }
  label(name) {
    this.labels.set(name, this.offset);
    return this;
  }
  target(name) {
    this.fixups.push([this.offset, name]);
    return this.u32(0);
  }
  /** `op` 1 = assign, 0xA = add, 4 = equal...; modes 0 immediate, 1 register, 2 variable. */
  expr(op, left, right, target, a, b, leftLevels = 0, rightLevels = 0) {
    return this.u16((op << 12) | (left << 10) | (right << 8) | (leftLevels << 4) | rightLevels)
      .u16(target)
      .u16(a)
      .u16(b);
  }
  op(opcode, ...operands) {
    this.u16(opcode);
    for (const operand of operands)
      if (typeof operand === 'string') this.target(operand);
      else this.u32(operand);
    return this;
  }
  build() {
    const out = Buffer.from(this.bytes);
    for (const [at, name] of this.fixups) out.writeUInt32LE(this.labels.get(name), at);
    return out;
  }
}
const variable = (index) => (1 << 16) | index;
const params = (...values) => [...values, ...Array(10 - values.length).fill(0)];

function interpreter(programs) {
  const memory = new RScriptMemory();
  const vm = new RScriptInterpreter(
    memory,
    RSCRIPT_1_11_LAYOUTS,
    new Map(),
    {
      program: async (script) => parseGsc(programs[script]),
      yieldFrame: async () => {},
    },
    new MsvcRandom(1),
  );
  return {memory, vm};
}

test('RScript interpreter evaluates expressions, indirection, calls and returns', async () => {
  const main = new Code()
    .expr(1, 2, 0, 1, 100, 7) // vars[100] = 7
    .expr(0xa, 2, 0, 2, 100, 5) // r2 = vars[100] + 5
    .expr(1, 2, 1, 1, 101, 2) // vars[101] = r2
    .expr(4, 2, 0, 0, 101, 12) // r0 = vars[101] == 12
    .op(0x03, 'skip') // jz skip: not taken
    .expr(1, 2, 0, 1, 102, 1)
    .label('skip')
    .expr(4, 2, 0, 0, 101, 13) // r0 = vars[101] == 13
    .op(0x03, 'skip2') // jz skip2: taken
    .expr(1, 2, 0, 1, 107, 1)
    .label('skip2')
    .expr(1, 2, 0, 1, 104, 100)
    .expr(1, 2, 2, 1, 103, 104, 0, 1) // vars[103] = vars[vars[104]]
    .op(0x0f, 2, 1, ...params(variable(101), 30)) // call script 2, label string 1
    .expr(1, 2, 2, 1, 105, 0) // vars[105] = vars[0]
    .op(0xc8, 'local', ...params(9)) // local call with vars[10] = 9
    .op(0x08)
    .label('local')
    .expr(0xb, 2, 0, 1, 10, 4) // r1 = vars[10] - 4
    .expr(1, 2, 1, 1, 106, 1)
    .op(0x10, 0);
  const sub = new Code()
    .op(0x08) // never reached: the call enters at the label
    .label('entry')
    .expr(0xa, 2, 2, 1, 10, 11) // r1 = vars[10] + vars[11]
    .expr(1, 2, 1, 1, 200, 1)
    .op(0x10, variable(200));
  const programs = {
    1: gsc({code: main.build(), strings: ['', 'entry']}),
    2: gsc({code: sub.build(), labels: [['entry', sub.labels.get('entry')]]}),
  };
  const {memory, vm} = interpreter(programs);
  await vm.load(1);
  await vm.run();
  const v = memory.variables;
  assert.deepEqual(
    [v[100], v[101], v[102], v[107], v[103], v[200], v[105], v[106]],
    [7, 12, 1, 0, 7, 42, 42, 5],
  );
  assert.equal(vm.depth, 0);
  assert.equal(vm.script, 1);
});

test('RScript text expansion inserts variables and string registers around double-byte text', () => {
  const {memory, vm} = interpreter({});
  memory.variables[5] = 7;
  memory.variables[7] = -3;
  memory.setSceneString(Scene.stringRegisters + 2 * Scene.stringStride, 201, Buffer.from('Ann'));
  // 0x8240 is a Shift-JIS character whose trail byte is '@'; it must not start a reference.
  const text = Buffer.concat([
    Buffer.from('@5/@@5 $2 '),
    Buffer.from([0x82, 0x40]),
    Buffer.from('$9$x'),
  ]);
  assert.deepEqual(
    Buffer.from(vm.expand(new Uint8Array(text))),
    Buffer.concat([Buffer.from('7/-3 Ann '), Buffer.from([0x82, 0x40]), Buffer.from('$x')]),
  );
});

test('RScript flag stores and the system save keep the native layout', () => {
  const store = new RScriptBitsetStore();
  store.add(0x1234, 9);
  store.add(2, 0);
  const encoded = store.encode();
  assert.deepEqual([...encoded], [2, 0, 0, 0, 2, 0, 1, 0, 0, 0, 1, 0x34, 0x12, 2, 0, 0, 0, 0, 2]);
  const copy = new RScriptBitsetStore();
  assert.equal(copy.decode(encoded), encoded.length);
  assert.ok(copy.has(0x1234, 9) && copy.has(2, 0) && !copy.has(2, 1));

  const memory = new RScriptMemory();
  memory.setConfigWord(0x0a, 200);
  memory.variables[7000] = -5;
  memory.variables[9999] = 12;
  memory.variables[10] = 99; // play-through variables are not part of the system save
  memory.readText.add(1001, 3);
  memory.seenImages.add(0, 42);
  const bytes = encodeSystemSave(memory);
  assert.equal(bytes.length, 0x872 + 6000 + 4 + 7 + 4 + 12);
  const restored = new RScriptMemory();
  decodeSystemSave(restored, bytes);
  assert.equal(restored.configWord(0x0a), 200);
  assert.deepEqual(
    [restored.variables[7000], restored.variables[9999], restored.variables[10]],
    [-5, 12, 0],
  );
  assert.ok(restored.readText.has(1001, 3) && restored.seenImages.has(0, 42));
  assert.throws(() => decodeSystemSave(restored, bytes.subarray(0, 100)), /Truncated/);
});

test('RScript slot saves keep the message snapshot, its header and the previous choice', () => {
  const memory = new RScriptMemory();
  memory.messageVariables[1] = 11;
  memory.messageVariables[3] = -3;
  memory.messageVariables[6999] = 5;
  memory.messageScene[0x8e] = 0x34;
  memory.messageScene[0x8f] = 0x12;
  memory.messageScene[0x1000] = 7;
  memory.previousScene[0x2000] = 9;
  memory.previousVariables[42] = 4;
  memory.scene[0x1000] = 1; // the live scene is not what a slot stores
  // At most 80 bytes of text; a double-byte character may end at the limit.
  const text = new Uint8Array([...Array(78).fill(0x41), 0x82, 0xa0, 0x42]);
  const bytes = encodeSlotSave(memory, text, new Date(2016, 11, 21, 9, 5));
  assert.equal(bytes.length, 0x68 + 2 * (0x996c + 14000));
  const header = decodeSlotHeader(bytes);
  assert.deepEqual(
    [header.year, header.month, header.day, header.hour, header.minute, header.background],
    [2016, 12, 21, 9, 5, 0x1234],
  );
  assert.deepEqual(header.variables, [11, 0, -3]);
  assert.equal(header.text.length, 80);
  // Shifted by one byte, the text ends with a single-byte character at the limit.
  const shifted = decodeSlotHeader(encodeSlotSave(memory, text.subarray(1), new Date())).text;
  assert.deepEqual([...shifted.subarray(76)], [0x41, 0x82, 0xa0, 0x42]);
  const loaded = new RScriptMemory();
  decodeSlotSave(loaded, bytes);
  assert.equal(loaded.scene[0x1000], 7);
  assert.deepEqual([loaded.variables[1], loaded.variables[6999]], [11, 5]);
  assert.equal(loaded.previousScene[0x2000], 9);
  assert.equal(loaded.previousVariables[42], 4);
  assert.throws(() => decodeSlotSave(loaded, bytes.subarray(0, 1000)), /Truncated/);
});

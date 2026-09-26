import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpDiagnostics} from '../dist/engines/buriko/native/diagnostics.js';
import {controlOpcodes} from '../dist/engines/buriko/bp/opcodes/control.js';
import {integerOpcodes} from '../dist/engines/buriko/bp/opcodes/integer.js';
import {memoryOpcodes} from '../dist/engines/buriko/bp/opcodes/memory.js';
import {localOpcodes} from '../dist/engines/buriko/bp/opcodes/locals.js';
import {fixedOpcodes, fixedResult, roundToInt32} from '../dist/engines/buriko/bp/opcodes/fixed.js';
import {nativeMathOpcodes} from '../dist/engines/buriko/bp/opcodes/native-math.js';

const handlers = {
  ...controlOpcodes,
  ...integerOpcodes,
  ...memoryOpcodes,
  ...localOpcodes,
  ...fixedOpcodes,
  ...nativeMathOpcodes,
};
function fixture(operands = [], bytes = []) {
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 256,
    frameCapacity: 256,
  });
  const memory = new BurikoBpMemory(new Uint8Array(1024));
  const notices = [];
  const diagnostics = new BurikoBpDiagnostics((notice) => notices.push(notice));
  thread.pc = 33;
  thread.instructionStart = 32;
  thread.frameCursor = 64;
  thread.moduleMemory.set(bytes, 33);
  for (const value of operands) push32(thread, value);
  return {thread, memory, diagnostics, notices};
}
const u16 = (value) => [value & 255, (value >>> 8) & 255];
const u32 = (value) => [
  value & 255,
  (value >>> 8) & 255,
  (value >>> 16) & 255,
  (value >>> 24) & 255,
];
function result(opcode, operands, bytes = []) {
  const h = fixture(operands, bytes);
  handlers[opcode](h);
  return pop32(h.thread);
}

test('primary pushes preserve signed widths and consume all eight bytes of control83', () => {
  assert.equal(result(0, [], [0x80]), 0xffffff80);
  assert.equal(result(1, [], [0xff, 0x80]), 0xffff80ff);
  assert.equal(result(2, [], u32(0x87654321)), 0x87654321);
  const h = fixture([], [0x83, ...u32(0x89abcdef), ...u32(0xfedcba98)]);
  handlers[3](h);
  assert.equal(pop32(h.thread), 0x89abcdef);
  assert.equal(h.thread.pc, 42);
  const ignored = fixture([123], [0x84, 255]);
  handlers[3](ignored);
  assert.equal(ignored.thread.pc, 34);
  assert.equal(pop32(ignored.thread), 123);
});

test('integer arithmetic uses signed operands, widened division, low products and masked shifts', () => {
  const values = [-2147483648, -2147483647, -65537, -1, 0, 1, 65537, 2147483647];
  for (const a of values)
    for (const b of values) {
      const wrap = (n) => Number(BigInt.asUintN(32, n));
      assert.equal(result(0x20, [a, b]), wrap(BigInt(a) + BigInt(b)));
      assert.equal(result(0x21, [a, b]), wrap(BigInt(a) - BigInt(b)));
      assert.equal(result(0x22, [a, b]), wrap(BigInt(a) * BigInt(b)));
      assert.equal(result(0x23, [a, b]), b === 0 ? 0x80000000 : wrap(BigInt(a) / BigInt(b)));
      assert.equal(result(0x24, [a, b]), b === 0 ? 0x80000000 : wrap(BigInt(a) % BigInt(b)));
    }
  assert.equal(result(0x29, [0x80000001, 32]), 0x80000001);
  assert.equal(result(0x2a, [0x80000001, 33]), 0x40000000);
  assert.equal(result(0x2b, [0x80000001, 33]), 0xc0000000);
  assert.equal(result(0x42, [2147483647, 2147483647, 2147483647]), 2147483647);
  assert.equal(result(0x56, [-1, 1]), 0xffffffff);
});

test('comparison selectors and eager stack condition selection retain native ordering', () => {
  const expected = [0, 1, 1, 0, 1, 0];
  for (let i = 0; i < 6; i++) assert.equal(result(0x30 + i, [-1, 0]), expected[i]);
  assert.equal(result(0x40, [1, 123, 456]), 123);
  assert.equal(result(0x40, [0, 123, 456]), 456);
  assert.equal(result(0x36, [0x86], [6, 0x82, 1]), 0x82);
});

test('relative jumps use instruction start and call return addresses share frame bytes', () => {
  const relative = fixture([], u16(-12));
  handlers[0x13](relative);
  assert.equal(relative.thread.pc, 20);
  assert.equal(relative.thread.instructionStart, 20);
  const h = fixture([100]);
  handlers[0x16](h);
  assert.deepEqual(h.thread.callSites, [32]);
  assert.equal(h.thread.frameCursor, 68);
  assert.equal(h.memory.readU32(h.thread, 0x20000040), 33);
  assert.equal(h.thread.pc, 100);
  h.memory.writeU32(h.thread, 0x20000040, 77);
  assert.equal(handlers[0x17](h), 0);
  assert.equal(h.thread.pc, 77);
  assert.equal(h.thread.frameCursor, 64);
  assert.deepEqual(h.thread.callSites, []);
  h.thread.frameCursor = 0;
  assert.equal(handlers[0x17](h), 4);
  const ee = fixture([], u16(40));
  handlers[0xee](ee);
  assert.equal(ee.thread.pc, 72);
  assert.equal(ee.memory.readU32(ee.thread, 0x20000040), 35);
  const ef = fixture([], u32(0x80000020));
  ef.memory.writeU32(ef.thread, 32, 100);
  handlers[0xef](ef);
  assert.equal(ef.memory.readU32(ef.thread, 0x20000040), 37);
});

test('calls and invalid branch encodings retain observed fault-side effects', () => {
  const invalid = fixture([0]);
  assert.throws(() => handlers[0x16](invalid), /invalid code/);
  assert.equal(invalid.thread.frameCursor, 68);
  assert.deepEqual(invalid.thread.callSites, [32]);
  const overflow = fixture([100]);
  overflow.thread.frameCursor = 255;
  assert.throws(() => handlers[0x16](overflow), /overflow/);
  assert.equal(pop32(overflow.thread), 100);
  const branch = fixture([1], [0x0e, ...u16(8)]);
  assert.throws(() => handlers[0x15](branch), /undefined native/);
  assert.equal(branch.thread.pc, 36);
  assert.equal(branch.thread.stackIndex, 0);
});

test('conditional branches validate only taken targets and ignore unused high bits', () => {
  const no = fixture([0, 0xfffffff0], [0x70]);
  handlers[0x15](no);
  assert.equal(no.thread.pc, 34);
  const yes = fixture([0], [0x89, ...u16(-8)]);
  handlers[0x15](yes);
  assert.equal(yes.thread.pc, 24);
  const comparison = fixture([5], [0x82, ...u16(10), 6]);
  handlers[0x37](comparison);
  assert.equal(comparison.thread.pc, 42);
});

test('packed local widths and full-word fused sources have different native semantics', () => {
  const h = fixture([], u16(0x8004));
  h.memory.writeU32(h.thread, 0x2000003c, 0xffffff80);
  handlers[0x19](h);
  assert.equal(pop32(h.thread), 0xffffff80);
  const byte = fixture([], u16(4));
  byte.memory.writeU32(byte.thread, 0x2000003c, 0x11223380);
  handlers[0x19](byte);
  assert.equal(pop32(byte.thread), 0xffffff80);
  const fused = fixture([], [...u32(32), ...u16(4), 5]);
  fused.memory.writeU32(fused.thread, 0x2000003c, 0x11223380);
  handlers[0xf0](fused);
  assert.equal(fused.memory.readU8(fused.thread, 32), 0x85);
  const divide = fixture([-2147483648], u16(0x8004));
  divide.memory.writeU32(divide.thread, 0x2000003c, 0xffffffff);
  assert.throws(() => handlers[0x1e](divide), /overflow/);
});

test('inline copy checks code capacity, keeps pc on failed check, and preserves overlap', () => {
  const h = fixture([0x10000023], [4, 1, 2, 3, 4]);
  handlers[0x0b](h);
  assert.deepEqual([...h.thread.moduleMemory.subarray(35, 39)], [1, 2, 3, 4]);
  assert.equal(h.thread.pc, 38);
  const bad = fixture([32], [255]);
  handlers[0x0b](bad);
  assert.equal(bad.thread.pc, 34);
  const zero = fixture([32], [0]);
  handlers[0x0b](zero);
  assert.equal(zero.thread.pc, 34);
});

test('watched scalar stores report before writes and preserve original stack reversal', () => {
  for (const opcode of [9, 10]) {
    const h = fixture(opcode === 9 ? [32, 0x12345678] : [0x12345678, 32], [2]);
    h.diagnostics.writeWatchEnabled = true;
    h.diagnostics.registerWriteWatch(h.thread, 32, 4, new Uint8Array([65]));
    handlers[opcode](h);
    assert.equal(h.memory.readU32(h.thread, 32), 0x12345678);
    assert.equal(h.notices.length, 1);
    assert.equal(h.notices[0].size, 4);
  }
  const sequence = fixture([32, 0x1111, 0x2222], [1, 2]);
  handlers[0x0c](sequence);
  assert.equal(sequence.memory.readU16(sequence.thread, 32), 0x1111);
  assert.equal(sequence.memory.readU16(sequence.thread, 34), 0x2222);
});

test('bulk copy is memmove and repeated source aliasing is sequential', () => {
  const h = fixture([33, 32, 4]);
  for (let i = 0; i < 5; i++) h.memory.writeU8(h.thread, 32 + i, i + 1);
  handlers[0x60](h);
  assert.deepEqual([...h.memory.globalMemory.subarray(32, 37)], [1, 1, 2, 3, 4]);
  const repeat = fixture([33, 1, 4, 32]);
  repeat.memory.writeU8(repeat.thread, 32, 7);
  handlers[0x64](repeat);
  assert.deepEqual([...repeat.memory.globalMemory.subarray(32, 37)], [7, 7, 7, 7, 7]);
});

test('64-bit arithmetic retains divide fault distinctions and wraps exact products', () => {
  const h = fixture([64, 32, 48]);
  h.memory.writeU64(h.thread, 32, 0x7fffffffffffffffn);
  h.memory.writeU64(h.thread, 48, 3n);
  handlers[0x52](h);
  assert.equal(h.memory.readU64(h.thread, 64), 0x7ffffffffffffffdn);
  const zero = fixture([64, 32, 48]);
  handlers[0x53](zero);
  assert.equal(zero.memory.readU64(zero.thread, 64), 0x8000000000000000n);
  const mod = fixture([64, 32, 48]);
  assert.throws(() => handlers[0x54](mod), /division fault/);
  const overflow = fixture([64, 32, 48]);
  overflow.memory.writeU64(overflow.thread, 32, 0x8000000000000000n);
  overflow.memory.writeU64(overflow.thread, 48, 0xffffffffffffffffn);
  assert.throws(() => handlers[0x53](overflow), /division fault/);
});

test('SIMD conversion uses nearest-even and strict fixed snapping thresholds', () => {
  assert.equal(roundToInt32(2.5), 2);
  assert.equal(roundToInt32(3.5), 4);
  assert.equal(roundToInt32(-1.5), -2);
  assert.equal(roundToInt32(2147483648), -2147483648);
  assert.equal(fixedResult(1 + 63 / 65536), 65536);
  assert.equal(fixedResult(1 + 64 / 65536), 65600);
  assert.equal(fixedResult(1 + 65472 / 65536), 131008);
  assert.equal(fixedResult(1 + 65473 / 65536), 131072);
  assert.equal(result(0x46, [2, 6, 1, 4]), 3 * 65536);
  assert.equal(result(0x47, [2 * 65536, 6 * 65536, 16384]), 3 * 65536);
  assert.equal(result(0x57, [5 * 65536, 2 * 65536]), Math.trunc(2.5 * 65536));
  assert.equal(result(0x57, [5 * 65536, 0]), 0);
});

test('scalar vector multiply sees overlap while packed vector add snapshots sources', () => {
  const h = fixture([36, 32, 2 * 65536]);
  [65536, 2 * 65536, 3 * 65536, 4 * 65536].forEach((v, i) =>
    h.memory.writeU32(h.thread, 32 + i * 4, v),
  );
  handlers[0x5e](h);
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => h.memory.readU32(h.thread, 36 + i * 4)),
    [2, 4, 8, 16].map((v) => v * 65536),
  );
  const normal = fixture([64, 32]);
  normal.memory.writeU32(normal.thread, 32, 3 * 65536);
  normal.memory.writeU32(normal.thread, 36, 4 * 65536);
  handlers[0x5d](normal);
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => normal.memory.readU32(normal.thread, 64 + i * 4)),
    [39322, 52429, 0, 5 * 65536],
  );
});

test('baseline CRT numeric wrappers cover quadrants, exceptional powers and overflow', () => {
  for (const [degrees, sine, cosine] of [
    [0, 0, 65536],
    [45, 46340, 46340],
    [90, 65536, 0],
    [180, 0, -65536],
    [270, -65536, 0],
    [-90, -65536, 0],
  ]) {
    assert.equal(result(0x48, [degrees * 65536]), sine >>> 0);
    assert.equal(result(0x49, [degrees * 65536]), cosine >>> 0);
  }
  for (const [x, y, angle] of [
    [1, 0, 0],
    [0, 1, 90],
    [0, -1, 270],
    [-1, 0, 180],
    [1, 1, 45],
    [-1, -1, 225],
  ])
    assert.equal(result(0x43, [x, y]), angle * 65536);
  assert.equal(result(0x44, [3, 4, 12]), 13);
  assert.equal(result(0x44, [2147483647, 2147483647, 2147483647]), 0x80000000);
  for (const [base, power, value] of [
    [2, 3, 8],
    [-2, 3, -8],
    [4, 0.5, 2],
    [2, -1, 0.5],
    [0, 0, 1],
  ])
    assert.equal(result(0x55, [base * 65536, power * 65536]), (value * 65536) >>> 0);
  assert.equal(result(0x55, [-2 * 65536, 32768]), 0x80000000);
  assert.equal(result(0x55, [0, -65536]), 0x80000000);
});

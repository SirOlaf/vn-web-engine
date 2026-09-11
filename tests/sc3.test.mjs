import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Sc3Script, MesScript} from '../dist/engines/mages/games/chaos-head-noah/sc3/script.js';
import {Sc3Fault} from '../dist/engines/mages/games/chaos-head-noah/sc3/runtime.js';
import {Sc3Expressions} from '../dist/engines/mages/games/chaos-head-noah/sc3/expression.js';
import {runtime, scriptBytes, mesBytes, literal, assignment} from './sc3-fixtures.mjs';

test('SC3 bootstrap loads archive ID 1 into slot 0 and initializes 100 contexts / 12 groups', async () => {
  const requested = [],
    vm = runtime([0, 3], requested),
    id = await vm.boot();
  assert.deepEqual(requested, [
    ['script', 1],
    ['messages', 1],
  ]);
  assert.equal(id, 0);
  assert.equal(vm.pc(id), 16);
  for (let i = 0; i < 100; i++) {
    const c = vm.context(i);
    assert.equal(c.getUint32(0x70, true), i);
    if (i)
      assert.equal(
        c.getBigUint64(0x150, true),
        i < 99 ? BigInt(0x1417a2f00 + (i + 1) * 0x160) : 0n,
      );
  }
  assert.equal(vm.context(0).getUint32(0x28, true), 65535);
  assert.equal(vm.context(0).getBigUint64(0x140, true), 0x1417a0dd0n);
  assert.equal(vm.context(0).getBigUint64(0x148, true), 0x1417a0f30n);
  for (let i = 0; i < 12; i++) {
    assert.equal(vm.state.get(0x17ab880 + i * 4), 0x20000000);
    assert.equal(vm.state.get(0x17ab8b0 + i * 4), i === 0 ? 1 : 0);
  }
  assert.equal(vm.state.flags.length, 1000);
  assert.equal(vm.state.variableBytes.length, 32000);
  assert.equal(vm.state.get(0x17abdbc), 64);
  assert.equal(vm.state.get(0x17add4c), -1);
  for (let i = 1; i < 100; i++) assert.equal(vm.allocateContext(i % 12), i);
  assert.throws(() => vm.allocateContext(0), /exhausted/);
  await assert.rejects(vm.boot(), /new runtime/);
});
test('unknown opcode halts at its original PC without operand consumption and remains faulted', async () => {
  const vm = runtime([0, 0x29, 3, 0, 0x02, 0, 0x81, 0, 0]);
  await vm.boot();
  let fault;
  try {
    vm.runContext(0);
  } catch (error) {
    fault = error;
  }
  assert.ok(fault instanceof Sc3Fault);
  assert.equal(fault.asset, 1);
  assert.equal(fault.slot, 0);
  assert.equal(fault.pc, 19);
  assert.equal(vm.pc(0), 19);
  assert.equal(vm.trace.length, 1);
  assert.match(fault.bytes, /^00 02 00 81/);
  assert.throws(
    () => vm.runContext(0),
    (e) => e === fault,
  );
});
test('standalone assignment preserves RHS return and writes native context result register', async () => {
  const vm = runtime([0xfe, ...assignment(0x28, 20, 123), 0, 3]);
  await vm.boot();
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.state.variable(20), 123);
  assert.equal(vm.context(0).getInt32(0x1c, true), 123);
});
test('context script-slot writes do not redirect the independent instruction pointer', async () => {
  const vm = runtime([0xfe, ...assignment(0x2d, 0x74 / 4, 15), 0, 3]);
  await vm.boot();
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.context(0).getUint32(0x74, true), 15);
  assert.equal(vm.trace[1].slot, 15);
  assert.equal(vm.trace[1].asset, 1);
});
test('view command evaluates all three operands, including side effects of its discarded operand', async () => {
  const vm = runtime([
    0,
    0x25,
    ...assignment(0x28, 20, 123),
    ...assignment(0x28, 21, -42),
    ...assignment(0x28, 22, 97),
    0,
    3,
  ]);
  await vm.boot();
  vm.runContext(0);
  assert.equal(vm.state.variable(20), 123);
  assert.equal(vm.state.variable(21), -42);
  assert.equal(vm.state.variable(22), 97);
  assert.equal(vm.state.variable(0x3444 / 4), -42);
  assert.equal(vm.state.variable(0x3448 / 4), 97);
  assert.equal(vm.context(0).getInt32(0x1c, true), 97);
});
test('flag command ignores negative indices but evaluates assignments before deciding', async () => {
  const vm = runtime([0, 0x12, ...assignment(0x28, 20, -1), 0, 0x12, ...literal(7999), 0, 3]);
  await vm.boot();
  vm.runContext(0);
  assert.equal(vm.state.variable(20), -1);
  assert.equal(vm.context(0).getInt32(0x1c, true), -1);
  assert.equal(vm.state.flag(7999), 1);
  assert.equal(
    vm.state.flags.reduce((a, b) => a + b, 0),
    128,
  );
});
test('end replaces context flags, retains PC, and yields; group high bit is masked', async () => {
  const vm = runtime([0x80, 0]);
  await vm.boot();
  vm.context(0).setUint32(0, 0x12345678, true);
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.pc(0), 16);
  assert.equal(vm.context(0).getUint32(0, true), 0x08000000);
});
test('debug instruction budget is distinct from native yield', async () => {
  const vm = runtime([0, 0x29, 3, 0, 3]);
  await vm.boot();
  assert.equal(vm.runContext(0, 1), 'budget');
  assert.equal(vm.state.get(0x179cd24), 0);
  assert.equal(vm.pc(0), 19);
  assert.equal(vm.runContext(0), 'yield');
});
test('group-10 native no-op aliases consume only their two-byte opcodes', async () => {
  const vm = runtime([0x10, 0x0b, 0x10, 0x2d, 0, 3]);
  await vm.boot();
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.pc(0), 22);
  assert.deepEqual(
    vm.trace.map((entry) => [entry.pc, entry.nextPc, entry.bytes.slice(0, 5)]),
    [
      [16, 18, '10 0b'],
      [18, 20, '10 2d'],
      [20, 22, '00 03'],
    ],
  );
});
test('scene-wave command preserves native table families, operand order and partial updates', async () => {
  const code = [
      16,
      0x30,
      0,
      16,
      0x30,
      1,
      ...literal(1),
      ...literal(2),
      ...literal(3),
      ...literal(4),
      ...literal(-5),
      16,
      0x30,
      4,
      ...literal(0),
      ...literal(-1),
      ...literal(12),
      ...literal(-3),
      ...literal(14),
      ...literal(15),
      16,
      0x30,
      2,
      16,
      0x30,
      3,
      ...literal(21),
      ...literal(22),
      ...literal(23),
      ...literal(24),
      ...literal(25),
      16,
      0x30,
      10,
      16,
      0x30,
      11,
      ...literal(31),
      ...literal(32),
      ...literal(33),
      ...literal(34),
      ...literal(35),
      16,
      0x30,
      12,
      ...literal(0),
      ...literal(41),
      ...literal(-42),
      ...literal(43),
      ...literal(-44),
      ...literal(45),
      16,
      0x30,
      6,
      16,
      0x30,
      9,
      16,
      0x30,
      13,
      16,
      0x30,
      255,
      0,
      3,
    ],
    vm = runtime(code);
  await vm.boot();
  vm.runContext(0);
  const s = vm.state;
  assert.equal(s.get(0x545654), 1);
  assert.deepEqual(
    Array.from({length: 5}, (_, i) => s.get(0x54d270 + i * 4)),
    [1, 12, 14, 3, 15],
  );
  assert.equal(s.get(0x56ce4c), 1);
  assert.deepEqual(
    Array.from({length: 5}, (_, i) => s.get(0x56ce50 + i * 4)),
    [21, 22, 24, 23, 25],
  );
  assert.equal(s.get(0x545224), 1);
  assert.deepEqual(
    Array.from({length: 5}, (_, i) => s.get(0x5494e0 + i * 4)),
    [41, 32, 34, 43, 45],
  );
  assert.equal(vm.pc(0), 16 + code.length);
});
test('extended frame wait repeats both expressions and obeys the global cancellation gate', async () => {
  const vm = runtime([0, 0x33, ...literal(3), ...assignment(0x28, 20, 7), 0, 3]);
  await vm.boot();
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.pc(0), 16);
  assert.equal(vm.context(0).getInt32(0x18, true), 3);
  assert.equal(vm.state.variable(20), 7);
  vm.state.setVariable(20, 0);
  vm.state.put(0x17ac374, 1);
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.context(0).getInt32(0x18, true), 0);
  assert.ok(vm.pc(0) > 16);
  assert.equal(vm.state.variable(20), 7);
});
test('linked-context completion removes the native handle bias with 32-bit wraparound', async () => {
  const vm = runtime([0, 0x1a, 0, 3]);
  await vm.boot();
  vm.context(0).setUint32(0x70, 0xffffffff, true);
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.context(0).getInt32(0x1c, true), 0x7fffffff);
});
test('audio reset opcode rewrites native fields while preserving channel-record holes', async () => {
  const vm = runtime([0, 0x3e, 0, 3]);
  await vm.boot();
  for (let channel = 0; channel < 10; channel++)
    vm.state.bytes(0x5a7110 + channel * 0x98, 0x98).fill(0xa5);
  assert.equal(vm.runContext(0), 'yield');
  for (let channel = 0; channel < 10; channel++) {
    const base = 0x5a7110 + channel * 0x98;
    assert.equal(vm.state.get(base), -1);
    assert.equal(vm.state.get(base + 0x14), -1);
    assert.equal(vm.state.get(base + 0x2c), -1);
    assert.equal(vm.state.get(base + 4), 0);
    assert.equal(vm.state.get(base + 0x90), 0);
    assert.equal(vm.state.bytes(base + 0x80, 1)[0], 0xa5);
  }
});
test('SC3 bounds and MES first-duplicate indexing retain asset identity', () => {
  const bytes = scriptBytes([0, 3]),
    script = new Sc3Script(37, bytes);
  bytes.fill(0);
  assert.equal(script.assetId, 37);
  assert.equal(script.label(0), 16);
  assert.throws(() => script.label(100), /range|bounds/i);
  assert.throws(() => new Sc3Script(1, new Uint8Array(4)));
  const m = Buffer.concat([mesBytes(), Buffer.alloc(24)]);
  m.writeUInt32LE(3, 8);
  [4, 4, 7].forEach((id, i) => m.writeInt32LE(id, 16 + i * 8));
  const mes = new MesScript(m);
  assert.deepEqual(
    [...mes.byId],
    [
      [4, 0],
      [7, 2],
    ],
  );
});
test('expression failures never substitute zero for unresolved arithmetic', async () => {
  const vm = runtime([0xfe, 0x13, 10, ...literal(7), 0, 3]);
  await vm.boot();
  assert.throws(() => vm.runContext(0), /Unresolved expression operator 0x13/);
  const malformed = runtime([0xfe, 0xe0, 1]);
  await malformed.boot();
  assert.throws(() => malformed.runContext(0), Sc3Fault);
  const expr = new Sc3Expressions();
  let pc = 0;
  const data = [...literal(-2147483648).slice(0, -1), 2, 10, ...literal(-1)];
  assert.throws(
    () => expr.evaluate({byte: () => data[pc++], inputPressed: 0, inputHeld: 0}),
    /division overflow/,
  );
});

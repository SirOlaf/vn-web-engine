import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runtime, literal, assignment} from './sc3-fixtures.mjs';
import {Sc3Fault} from '../dist/engines/mages/games/chaos-head-noah/sc3/runtime.js';
async function fixture(child, grandchild = [0, 3]) {
  const bytes = Buffer.alloc(512);
  bytes.write('SC3\0');
  bytes.writeUInt32LE(512, 4);
  bytes.writeUInt32LE(512, 8);
  [64, 160, 256].forEach((v, i) => bytes.writeUInt32LE(v, 12 + i * 4));
  bytes.set([...spawn(2, 1), 0, 3, 0, 0], 64);
  bytes.set(child, 160);
  bytes.set(grandchild, 256);
  const vm = runtime([]);
  vm.assets.script = async () => bytes;
  await vm.boot();
  return vm;
}
const spawn = (group, label) => [0, 1, ...literal(group), ...literal(0), label, 0];
test('nested dispatch budgets preserve parent continuation, handles and inner fault location', async () => {
  const vm = await fixture([...spawn(5, 2), 0, 3], [0, 2]);
  assert.equal(vm.runContext(0, 1), 'budget');
  assert.equal(vm.state.get(0x17a0c8c), 1);
  assert.equal(vm.runContext(0, 1), 'budget');
  assert.equal(vm.state.get(0x17a0c8c), 2);
  assert.throws(() => vm.runContext(1), /root context/);
  assert.throws(() => vm.publishLoadCompletions(), /suspended/);
  let fault;
  try {
    vm.runContext(0, 1);
  } catch (e) {
    fault = e;
  }
  assert.ok(fault instanceof Sc3Fault);
  assert.equal(fault.context, 2);
  assert.equal(fault.pc, 256);
  assert.equal(vm.trace.length, 0);
  assert.equal(vm.context(0).getUint32(0x1c, true), 0x80000001);
  assert.equal(vm.context(2).getUint32(0x1c, true), 0x80000001);
  assert.throws(
    () => vm.runFrame(),
    (e) => e === fault,
  );
});
test('child executes immediately but is absent from the current scheduler snapshot', async () => {
  const vm = await fixture([0, 3, 0, 0]);
  assert.equal(vm.runFrame(1), 'budget');
  assert.equal(vm.state.view(0x17ab8e8, 8).getBigUint64(0, true), 0n);
  while (vm.runFrame(1) === 'budget') {}
  assert.deepEqual(
    vm.trace.map((t) => [t.context, t.operation, t.yielded]),
    [
      [1, 'yield', true],
      [0, 'spawn context', false],
      [0, 'yield', true],
    ],
  );
  assert.equal(vm.state.get(0x17a0c8c), 1);
  assert.equal(vm.context(1).getUint32(0x1c, true), 0x80000000);
  assert.equal(vm.runFrame(), 'complete');
  assert.equal(vm.state.get(0x17ab8b0), 0);
  assert.equal(vm.state.get(0x17ab8b8), 0);
});
test('suspended child retains its PC and flags and is skipped on subsequent passes', async () => {
  const vm = await fixture([0, 6]);
  vm.runFrame();
  assert.equal(vm.pc(1), 160);
  assert.equal(vm.context(1).getUint32(0, true), 0x40000000);
  vm.runFrame();
  assert.equal(vm.pc(1), 160);
  assert.equal(vm.state.get(0x17ab8b8), 1);
});
test('context writes evaluate both expressions before overwriting the destination', async () => {
  const vm = runtime([0, 24, ...assignment(0x28, 20, 7), ...assignment(0x28, 21, -42), 0, 3]);
  await vm.boot();
  vm.runContext(0);
  assert.equal(vm.state.variable(20), 7);
  assert.equal(vm.state.variable(21), -42);
  assert.equal(vm.context(0).getInt32(0x1c, true), -42);
});
test('flag wait repeats expression side effects and compares the literal byte without boolean coercion', async () => {
  const vm = runtime([0, 17, 0, ...assignment(0x28, 20, 7), 0, 3]);
  await vm.boot();
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.pc(0), 16);
  assert.equal(vm.state.variable(20), 7);
  vm.state.setFlag(7, 1);
  vm.runContext(0);
  assert.ok(vm.pc(0) > 16);
  const other = runtime([0, 17, 2, ...literal(7), 0, 3]);
  await other.boot();
  other.runContext(0);
  assert.ok(other.pc(0) > 16);
  const clear = runtime([0, 19, ...assignment(0x28, 20, 7), 0, 19, ...literal(-1), 0, 3]);
  await clear.boot();
  clear.state.flags[0] = 255;
  clear.runContext(0);
  assert.equal(clear.state.flags[0], 127);
  assert.equal(clear.context(0).getInt32(0x1c, true), 7);
});

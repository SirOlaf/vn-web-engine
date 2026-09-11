import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runtime, literal, assignment} from './sc3-fixtures.mjs';

test('00/19 suspends its group on the next scheduling pass and can resume it', async () => {
  const vm = runtime([
    0,
    0x19,
    ...literal(0),
    ...literal(1),
    0,
    3,
    0,
    3,
    0,
    0x19,
    ...literal(0),
    ...literal(2),
    0,
    3,
  ]);
  await vm.boot();
  assert.equal(vm.runFrame(), 'complete');
  assert.equal(vm.pc(0), 34);
  assert.equal(vm.runFrame(), 'complete');
  assert.equal(vm.pc(0), 34);
  // Invoke selector 2 from a separate context, as suspended groups cannot run themselves.
  const controller = vm.allocateContext(1),
    c = vm.context(controller);
  c.setUint32(0x14, 1, true);
  c.setBigUint64(0x158, 0x200000000n + 36n, true);
  vm.runContext(controller);
  vm.releaseContext(controller);
  assert.equal(vm.runFrame(), 'complete');
  assert.equal(vm.pc(0), 36);
});

test('00/19 group termination releases suspended contexts and clears the one-shot group bit', async () => {
  const vm = runtime([0, 0x19, ...literal(0), ...literal(0), 0, 3]);
  await vm.boot();
  vm.runFrame();
  assert.equal(vm.state.get(0x17ab8b0), 1);
  vm.context(0).setUint32(0, 0x40000000, true);
  vm.runFrame();
  assert.equal(vm.state.get(0x17ab8b0), 0);
  assert.equal(vm.state.get(0x17ab880) & 0x08000000, 0);
  assert.equal(vm.allocateContext(0), 0);
});

test('00/19 does not dereference an invalid unsigned index for an unknown selector', async () => {
  const vm = runtime([0, 0x19, ...assignment(0x28, 40, -1), ...assignment(0x28, 41, 5), 0, 3]);
  await vm.boot();
  vm.runContext(0);
  assert.equal(vm.state.variable(40), -1);
  assert.equal(vm.state.variable(41), 5);
  const invalid = runtime([0, 0x19, ...literal(-1), ...literal(0)]);
  await invalid.boot();
  assert.throws(() => invalid.runContext(0), /Unmapped Noah state/);
});

test('10/3d busy gate preserves PC and expression side effects until it becomes idle', async () => {
  const vm = runtime([0x10, 0x3d, ...assignment(0x28, 40, 123), 0, 3]);
  await vm.boot();
  vm.state.put(0x81007c, -1);
  vm.context(0).setInt32(0x1c, 456, true);
  vm.runContext(0);
  assert.equal(vm.pc(0), 16);
  assert.equal(vm.state.variable(40), 0);
  assert.equal(vm.context(0).getInt32(0x1c, true), 456);
  vm.state.put(0x81007c, 0);
  vm.runContext(0);
  assert.equal(vm.state.variable(40), 123);
  assert.equal(vm.pc(0), 16 + 2 + assignment(0x28, 40, 123).length + 2);
});

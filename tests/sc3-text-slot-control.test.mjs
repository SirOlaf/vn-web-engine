import test from 'node:test';
import assert from 'node:assert/strict';
import {runtime, literal} from './sc3-fixtures.mjs';

async function fixture(mode, {slot = 2, value = 0, flag = 0, explicit} = {}) {
  const vm = runtime([1, 0x11, mode, ...(explicit === undefined ? [] : literal(explicit)), 0, 3]);
  await vm.boot();
  const selected = explicit ?? slot;
  vm.context(0).setInt32(0x13c, slot, true);
  vm.state.setVariable(0x839 + selected, value);
  vm.state.setFlag(0x9c6 + selected, flag);
  vm.state.put(0x80c4d0 + selected * 4, 0x12345678);
  vm.state.put(0x80cff0 + selected * 4, 0x76543210);
  return vm;
}

test('01/11 activates and deactivates the current text slot only on state transitions', async () => {
  let vm = await fixture(0, {flag: 1});
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.state.flag(0x9c8), 0);
  assert.equal(vm.pc(0), 19);
  vm = await fixture(0, {flag: 0});
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.trace.length, 2);
  vm = await fixture(1, {flag: 0, value: 0});
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.state.flag(0x9c8), 1);
  assert.equal(vm.state.get(0x80c4d8), 0);
  assert.equal(vm.state.get(0x80cff8), 0);
  vm = await fixture(1, {flag: 1, value: 0});
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.state.get(0x80c4d8), 0x12345678);
});

test('01/11 completion waits retry the complete opcode under native unsigned tests', async () => {
  let vm = await fixture(2, {value: 255});
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.pc(0), 16);
  vm = await fixture(2, {value: 256});
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.pc(0), 21);
  vm = await fixture(3, {value: -1});
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.pc(0), 16);
  vm = await fixture(3, {value: 0});
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.pc(0), 21);
});

test('01/11 explicit-slot variants update context and preserve the distinct reset branches', async () => {
  let vm = await fixture(5, {slot: 1, explicit: 4, flag: 1});
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.context(0).getInt32(0x13c, true), 4);
  assert.equal(vm.context(0).getInt32(0x1c, true), 0);
  assert.equal(vm.state.flag(0x9ca), 0);
  vm = await fixture(6, {explicit: 4, flag: 0, value: 1});
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.state.flag(0x9ca), 1);
  assert.equal(vm.state.get(0x80c4e0), 0x12345678);
  vm = await fixture(4, {slot: 4, flag: 1, value: 9});
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.state.flag(0x9ca), 0);
  assert.equal(vm.state.variable(0x83d), 0);
  assert.equal(vm.state.get(0x80c4e0), 0x12345678);
  assert.equal(vm.state.get(0x80d000), 0);
  vm = await fixture(7, {slot: 1, explicit: 4, flag: 1, value: 9});
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.state.flag(0x9ca), 0);
  assert.equal(vm.state.variable(0x83d), 0);
  assert.equal(vm.state.get(0x80d000), 0x76543210);
});

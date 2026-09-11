import test from 'node:test';
import assert from 'node:assert/strict';
import {runtime} from './sc3-fixtures.mjs';

async function fixture(mode, age, remaining, pressed) {
  const vm = runtime([0x10, 0x21, mode, 0, 3]);
  await vm.boot();
  vm.state.setVariable(0x36bc / 4, age);
  vm.state.put(0x5a983c, remaining);
  vm.state.put(0x5a70d4, pressed);
  assert.equal(vm.runContext(0), 'yield');
  return vm;
}

test('10/21 consumes its selector and ignores modes other than one', async () => {
  const vm = await fixture(0xff, 100, 7, 0x12345678);
  assert.equal(vm.pc(0), 21);
  assert.equal(vm.state.get(0x5a983c), 7);
  assert.equal(vm.state.get(0x5a70d4), 0x12345678);
});

test('10/21 waits for age 32, decrements only a nonzero guard, and keeps the final edge', async () => {
  let vm = await fixture(1, 31, 2, 0x12345678);
  assert.equal(vm.state.get(0x5a983c), 2);
  assert.equal(vm.state.get(0x5a70d4), 0x12345678);
  vm = await fixture(1, 32, 0, 0x12345678);
  assert.equal(vm.state.get(0x5a983c), 0);
  assert.equal(vm.state.get(0x5a70d4), 0x12345678);
  vm = await fixture(1, 32, 1, 0x1000);
  assert.equal(vm.state.get(0x5a983c), 0);
  assert.equal(vm.state.get(0x5a70d4), 0x1000);
});

test('10/21 swallows the complete pressed mask while confirm/cancel guard time remains', async () => {
  for (const binding of [0x872dd4, 0x872dd8]) {
    const initial = 0x40000 | 0x80;
    const vm = runtime([0x10, 0x21, 1, 0, 3]);
    await vm.boot();
    vm.state.setVariable(0x36bc / 4, 32);
    vm.state.put(0x5a983c, 2);
    vm.state.put(0x5a70d4, initial | vm.state.get(binding));
    assert.equal(vm.runContext(0), 'yield');
    assert.equal(vm.state.get(0x5a983c), 1);
    assert.equal(vm.state.get(0x5a70d4), 0);
  }
  const vm = await fixture(1, -1, 2, 0x40000);
  assert.equal(vm.state.get(0x5a983c), 1);
  assert.equal(vm.state.get(0x5a70d4), 0x40000);
});

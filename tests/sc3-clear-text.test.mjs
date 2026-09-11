import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runtime, literal} from './sc3-fixtures.mjs';

test('01/0a retries its expression through the final fade tick and clears on the next call', async () => {
  const vm = runtime([1, 10, 0, ...literal(0), 0, 3]);
  await vm.boot();
  const s = vm.state;
  s.put(0x5b10ac, 2);
  s.put(0x5b10b0, 2);
  s.put(0x5bfb44, 0);
  s.put(0x5bfb48, -1);
  s.put(0x5c20c4, 16, 1);
  s.put(0x5c20c5, 255, 1);
  s.put(0x80cff0, 77);
  s.put(0x80c4d0, 88);
  s.setFlag(0x4e3, 1);
  vm.runContext(0);
  assert.equal(vm.pc(0), 16);
  assert.equal(s.get(0x5b10b0), 3);
  assert.deepEqual([...s.bytes(0x5c20c4, 2)], [0, 255]);
  vm.runContext(0);
  assert.equal(vm.pc(0), 16);
  assert.equal(s.get(0x5b10b0), 4);
  assert.equal(s.get(0x5b10ac), 2);
  vm.runContext(0);
  assert.equal(vm.pc(0), 28);
  assert.equal(s.get(0x5b10ac), 0);
  assert.equal(s.get(0x80cff0), 0);
  assert.equal(s.get(0x80c4d0), 88);
  assert.equal(s.flag(0x771), 1);
  assert.equal(s.flag(0x4e3), 0);
});

test('01/0a all-slot fade waits for every pre-call status, including instant fades', async () => {
  const vm = runtime([1, 10, 1, 0, 3]);
  await vm.boot();
  const s = vm.state;
  for (let i = 0; i < 3; i++) {
    s.put(0x5b10ac + i * 0x11984, 1);
    s.put(0x5b10b0 + i * 0x11984, 2);
    s.put(0x17ac258 + i * 4, 1);
    s.put(0x5c20c4 + i * 0x11984, 255, 1);
  }
  vm.runContext(0);
  assert.equal(vm.pc(0), 16);
  for (let i = 0; i < 3; i++) {
    assert.equal(s.get(0x5b10b0 + i * 0x11984), 4);
    assert.equal(s.get(0x5b10ac + i * 0x11984), 1);
    assert.equal(s.flag(0x771 + i), 1);
  }
  vm.runContext(0);
  assert.equal(vm.pc(0), 21);
  for (let i = 0; i < 3; i++) assert.equal(s.get(0x5b10ac + i * 0x11984), 0);
});

test('01/0a even default selectors evaluate expressions and odd defaults consume no operand', async () => {
  const increment = [0x28, 10, ...literal(50).slice(0, -1), 0x17, 0, ...literal(1)];
  const vm = runtime([1, 10, 254, ...increment, 1, 10, 255, 0, 3]);
  await vm.boot();
  vm.runContext(0);
  assert.equal(vm.state.variable(50), 1);
  assert.equal(vm.pc(0), 16 + 3 + increment.length + 3 + 2);
});

test('01/0a selected reset waits for window opacity and preserves unrelated fields', async () => {
  const vm = runtime([1, 10, 4, 0, 3]);
  await vm.boot();
  const s = vm.state;
  vm.context(0).setUint32(0x13c, 2, true);
  s.setVariable(0x83b, 1);
  s.put(0x5b10b5 + 2 * 0x11984, 7, 1);
  s.put(0x5b10ac + 2 * 0x11984, 3);
  vm.runContext(0);
  assert.equal(vm.pc(0), 16);
  assert.equal(s.get(0x5b10ac + 2 * 0x11984), 3);
  s.setVariable(0x83b, 0);
  vm.runContext(0);
  assert.equal(vm.pc(0), 21);
  assert.equal(s.get(0x5b10ac + 2 * 0x11984), 0);
  assert.equal(s.bytes(0x5b10b5 + 2 * 0x11984, 1)[0], 7);
});

test('01/0a re-evaluates a side-effecting slot expression on retry', async () => {
  const increment = [0x28, 10, ...literal(50).slice(0, -1), 0x17, 0, ...literal(1)];
  const vm = runtime([1, 10, 0, ...increment, 0, 3]);
  await vm.boot();
  const s = vm.state;
  s.setVariable(50, 0);
  s.put(0x5b10ac + 0x11984, 0);
  s.put(0x5b10b0 + 0x11984, 1);
  vm.runContext(0);
  assert.equal(vm.pc(0), 16);
  assert.equal(s.variable(50), 1);
  s.put(0x5b10b0 + 0x11984, 4);
  vm.runContext(0);
  assert.equal(vm.pc(0), 16 + 3 + increment.length + 2);
  assert.equal(s.variable(50), 2);
  assert.equal(s.get(0x5b10ac + 0x11984), 0);
});

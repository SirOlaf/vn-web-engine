import test from 'node:test';
import assert from 'node:assert/strict';
import {runtime, literal} from './sc3-fixtures.mjs';

test('10/04 packs three-component entries below four and four-component entries above it', async () => {
  let vm = runtime([0x10, 4, 3, ...literal(0x12), ...literal(0x34), ...literal(0x56), 0, 3]);
  await vm.boot();
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.state.variable(0x4628 / 4 + 3), 0x561234);
  vm = runtime([
    0x10,
    4,
    4,
    ...literal(0x12),
    ...literal(0x34),
    ...literal(0x78),
    ...literal(0x56),
    0,
    3,
  ]);
  await vm.boot();
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.state.variable(0x4628 / 4), 0x78561234);
  vm = runtime([
    0x10,
    4,
    255,
    ...literal(0x12),
    ...literal(0x34),
    ...literal(0x78),
    ...literal(0x56),
    0,
    3,
  ]);
  await vm.boot();
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.state.variable(0x4628 / 4 + 251), 0x78561234);
});

test('10/04 preserves native 32-bit shift/add overflow and expression side effects', async () => {
  const vm = runtime([
    0x10,
    4,
    0,
    ...literal(-1),
    ...literal(0x7fffffff),
    ...literal(0x80000000),
    0,
    3,
  ]);
  await vm.boot();
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.state.variable(0x4628 / 4), 0x7ffffeff | 0);
  assert.equal(vm.context(0).getInt32(0x1c, true), 0);
});

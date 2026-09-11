import test from 'node:test';
import assert from 'node:assert/strict';
import {runtime, literal, assignment} from './sc3-fixtures.mjs';

const code = (index, enabled, middle, low) => [
  0x10,
  0x2a,
  index,
  ...literal(enabled),
  ...literal(middle),
  ...literal(low),
  0,
  3,
];

test('10/2a maps one-hot masks and writes each of the four compositor descriptors', async () => {
  for (let index = 0; index < 4; index++) {
    const vm = runtime(code(index, 0x12345, 0x8000, 1));
    await vm.boot();
    assert.equal(vm.runContext(0), 'yield');
    assert.equal(vm.state.variable((0x5aa0 + index * 0x50) / 4), 0x23450f00);
  }
});

test('10/2a zeroes disabled descriptors, preserves invalid-mask underflow, and consumes unknown selectors', async () => {
  let vm = runtime(code(0, 0, 0x8000, 1));
  await vm.boot();
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.state.variable(0x5aa0 / 4), 0);
  vm = runtime(code(1, 1, 3, 0x10000));
  await vm.boot();
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.state.variable(0x5af0 / 4), 0xfeff);
  vm = runtime([
    0x10,
    0x2a,
    255,
    ...assignment(0x28, 20, 7),
    ...assignment(0x28, 21, 8),
    ...assignment(0x28, 22, 9),
    0,
    3,
  ]);
  await vm.boot();
  assert.equal(vm.runContext(0), 'yield');
  assert.deepEqual(
    [20, 21, 22].map((i) => vm.state.variable(i)),
    [7, 8, 9],
  );
});

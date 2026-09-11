import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assignment, runtime} from './sc3-fixtures.mjs';

test('00/1f stores the evaluated int32 branch value after expression side effects', async () => {
  const vm = runtime([0, 0x1f, ...assignment(0x28, 20, -42), 0, 3]);
  await vm.boot();
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.state.variable(20), -42);
  assert.equal(vm.context(0).getInt32(0x1c, true), -42);
  assert.equal(vm.state.get(0x179e6f8), -42);
});

test('00/20 always resolves its label and only redirects the PC on exact int32 equality', async () => {
  for (const [stored, value, taken] of [
    [-42, -42, true],
    [-42, 42, false],
  ]) {
    const expression = assignment(0x28, 20, value),
      code = [0, 0x20, ...expression, 0, 0, 0, 3],
      vm = runtime(code);
    await vm.boot();
    vm.state.put(0x179e6f8, stored);
    assert.equal(vm.runContext(0, 1), 'budget');
    assert.equal(vm.state.variable(20), value);
    assert.equal(vm.context(0).getInt32(0x1c, true), value);
    assert.equal(vm.pc(0), taken ? 16 : 16 + 2 + expression.length + 2);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {runtime, literal, assignment} from './sc3-fixtures.mjs';

test('10/10 waits without consuming its expression while the graphics gate is active', async () => {
  const vm = runtime([0x10, 0x10, ...assignment(0x28, 20, 7), 0, 3]);
  await vm.boot();
  vm.state.put(0x81007c, 1);
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.pc(0), 16);
  assert.equal(vm.state.variable(20), 0);
});

test('10/10 maps one-hot background slots, clears both dimensions, and releases the surface', async () => {
  for (const [mask, index] of [
    [1, 0],
    [2, 1],
    [0x8000, 15],
  ]) {
    const vm = runtime([0x10, 0x10, ...literal(mask), 0, 3]);
    await vm.boot();
    const target = index + 20;
    vm.state.setVariable(0x3520 / 4 + index, target);
    vm.state.setVariable(0x466c / 4 + index * 40, 123);
    vm.state.setVariable(3000 + index * 2, 640);
    vm.state.setVariable(3001 + index * 2, 360);
    vm.textures.createRgba(target, 2, 2);
    assert.equal(vm.runContext(0), 'yield');
    assert.equal(vm.state.variable(0x466c / 4 + index * 40), 65535);
    assert.equal(vm.state.variable(3000 + index * 2), 0);
    assert.equal(vm.state.variable(3001 + index * 2), 0);
    assert.equal(vm.textures.resources.has(target), false);
  }
});

test('10/10 retains native invalid-mask index minus one', async () => {
  const vm = runtime([0x10, 0x10, ...literal(3), 0, 3]);
  await vm.boot();
  vm.state.setVariable(0x3520 / 4 - 1, 7);
  vm.state.setVariable(0x466c / 4 - 40, 123);
  vm.textures.createRgba(7, 1, 1);
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.state.variable(0x466c / 4 - 40), 65535);
  assert.equal(vm.textures.resources.has(7), false);
});

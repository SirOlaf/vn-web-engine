import test from 'node:test';
import assert from 'node:assert/strict';
import {runtime, literal, assignment} from './sc3-fixtures.mjs';

test('10/11 waits at the original PC while the graphics gate is active', async () => {
  const vm = runtime([0x10, 0x11, ...assignment(0x28, 20, 7), 0, 3]);
  await vm.boot();
  vm.state.put(0x81007c, 1);
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.pc(0), 16);
  assert.equal(vm.state.variable(20), 0);
});

test('10/11 releases character texture and remaps surface IDs 8 through 15 to compositor slots', async () => {
  const vm = runtime([0x10, 0x11, ...literal(1), 0, 3]);
  await vm.boot();
  vm.state.setVariable(0x35e8 / 4, 8);
  vm.state.setVariable(0x4fd4 / 4, 123);
  vm.textures.createRgba(8, 1, 1);
  const record = vm.state.bytes(0x1d51200, 0xe0);
  record.fill(0xa5);
  record[0] = 1;
  for (const offset of [0x30, 0x40, 0x48, 0x88]) record.fill(0, offset, offset + 8);
  for (let i = 0; i < 8; i++) record[0x70 + i] = i + 1;
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.state.variable(0x4fd4 / 4), 65535);
  assert.equal(vm.textures.resources.has(8), false);
  assert.equal(record[0], 0);
  assert.deepEqual([...record.subarray(0x91, 0x98)], [2, 3, 4, 5, 6, 7, 8]);
  assert.ok(record.subarray(0x98, 0xb0).every((b) => b === 0));
  assert.equal(record[1], 0xa5);
});

test('10/11 retains the native invalid-mask index and direct compositor IDs', async () => {
  const vm = runtime([0x10, 0x11, ...literal(3), 0, 3]);
  await vm.boot();
  vm.state.setVariable(0x35e8 / 4 - 1, 2);
  vm.state.setVariable(0x4fd4 / 4 - 40, 123);
  vm.textures.createRgba(2, 1, 1);
  vm.state.put(0x1d51200 + 2 * 0xe0, 0, 1);
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.state.variable(0x4fd4 / 4 - 40), 65535);
  assert.equal(vm.textures.resources.has(2), false);
});

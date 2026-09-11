import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runtime, assignment} from './sc3-fixtures.mjs';

test('00/34 requests application exit without advancing or modifying its context', async () => {
  const vm = runtime([0, 0x34]);
  await vm.boot();
  const context = new Uint8Array(
    vm.context(0).buffer,
    vm.context(0).byteOffset,
    vm.context(0).byteLength,
  ).slice();
  const configuration = vm.storage.configuration.slice();
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.exitRequested, true);
  assert.equal(vm.pc(0), 16);
  assert.deepEqual(
    new Uint8Array(vm.context(0).buffer, vm.context(0).byteOffset, vm.context(0).byteLength),
    new Uint8Array(context),
  );
  assert.deepEqual(vm.storage.configuration, configuration);
  assert.equal(vm.state.get(0x179cd24), 1);
});

test('application exit finishes the current scheduling pass and closes at the next host pump', async () => {
  const other = [0xfe, ...assignment(0x28, 40, 123), 0, 3];
  const vm = runtime([0, 0x34, ...other]);
  await vm.boot();
  const id = vm.allocateContext(0),
    c = vm.context(id);
  c.setBigUint64(0x158, 0x200000012n, true);
  c.setInt32(0x10, -1, true);
  let audio = 0,
    movies = 0;
  vm.audio.dispose = () => {
    audio++;
  };
  vm.movies.dispose = () => {
    movies++;
  };
  assert.equal(vm.runFrame(), 'complete');
  assert.equal(vm.state.variable(40), 123);
  assert.equal(audio, 0);
  assert.equal(movies, 0);
  const trace = vm.trace.length,
    clock = vm.state.variableBytes.slice();
  assert.equal(vm.runFrame(), 'exited');
  assert.equal(vm.runFrame(), 'exited');
  assert.equal(audio, 1);
  assert.equal(movies, 1);
  assert.equal(vm.trace.length, trace);
  assert.deepEqual(vm.state.variableBytes, clock);
});

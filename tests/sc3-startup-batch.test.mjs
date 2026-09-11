import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runtime, literal} from './sc3-fixtures.mjs';
import {copyContext} from '../dist/engines/mages/games/chaos-head-noah/sc3/opcodes/copy-context.js';
import {NoahMovieDevices} from '../dist/engines/mages/games/chaos-head-noah/sc3/movie-devices.js';

test('00/28 zero means the invoking context even when its ID field was changed', async () => {
  const vm = runtime([0, 3]);
  await vm.boot();
  const s = vm.state,
    c = vm.context(7);
  c.setUint32(0x70, 99, true);
  c.setInt32(0xbc, 123, true);
  const operands = [0, 0x80000000, 0, 1];
  copyContext({state: s, context: c, skip() {}, expression: () => operands.shift()});
  assert.equal(vm.context(0).getInt32(0xbc, true), 123);
  assert.equal(vm.context(99).getInt32(0xbc, true), 0);
});

test('00/28 copies forward across overlapping context storage', async () => {
  const vm = runtime([0, 3]);
  await vm.boot();
  const s = vm.state,
    base = 0x17a2f00;
  for (let i = 0; i < 180; i++) s.put(base + i * 4, i + 1000);
  const values = [0x80000000, 1, 0, 100],
    expected = s.bytes(base, 0x500).slice(),
    view = new DataView(expected.buffer);
  for (let i = 0; i < 100; i++)
    view.setInt32(0x160 + 0xbc + i * 4, view.getInt32(0xbc + i * 4, true), true);
  copyContext({state: s, context: vm.context(0), skip() {}, expression: () => values.shift()});
  assert.deepEqual(s.bytes(base, 0x500), expected);
});

test('00/37 yields after requesting sound and 00/39 waits until the channel completes', async () => {
  const code = [0, 0x37, 0, ...literal(1), ...literal(0), 0, 0x39, 0, 0, 3],
    vm = runtime(code);
  await vm.boot();
  const s = vm.state,
    b = 0x5a7110 + 3 * 0x98;
  vm.runContext(0);
  assert.equal(vm.pc(0), 33);
  assert.deepEqual(
    [0, 4, 8, 12].map((o) => s.get(b + o)),
    [1, 0, 1, 1],
  );
  vm.runContext(0);
  assert.equal(vm.pc(0), 33);
  s.put(b + 12, 0);
  s.put(b + 0x38, 1);
  s.put(b + 0x3c, 0);
  vm.runContext(0);
  assert.equal(vm.pc(0), 33);
  s.put(b + 0x3c, 1);
  vm.runContext(0);
  assert.equal(vm.pc(0), 38);
});

test('01/23 delayed cancel preserves the old active bit for one final retry', async () => {
  const vm = runtime([1, 0x23, 0, 0, 3]);
  await vm.boot();
  const s = vm.state;
  s.flags[0xe7] = 8;
  s.put(0x179ccf0, 7, 1);
  s.setVariable(0x62f4 / 4, 123);
  vm.runContext(0);
  assert.equal(vm.pc(0), 16);
  assert.equal(s.flags[0xe7] & 8, 0);
  assert.equal(s.flags[0xe8] & 1, 1);
  assert.equal(s.variable(0x62f4 / 4), 123);
  vm.runContext(0);
  assert.equal(vm.pc(0), 21);
  assert.equal(s.variable(0x62f4 / 4), 65535);
});

test('01/23 selector 22 stops device zero while clearing channel-one flags and IDs', async () => {
  const vm = runtime([1, 0x23, 22, 0, 3]);
  await vm.boot();
  const s = vm.state;
  s.flags[0xe7] = 24;
  s.flags[0x9a] = 255;
  s.flags[0x136] = 255;
  s.put(0x5a6e20, 11);
  s.put(0x5a6e24, 22);
  s.setVariable(0x62f4 / 4, 123);
  s.setVariable(0x6350 / 4, 456);
  vm.runContext(0);
  assert.equal(s.get(0x5a6e20), 0);
  assert.equal(s.get(0x5a6e24), 22);
  assert.equal(s.flags[0xe7], 8);
  assert.equal(s.flags[0x9a], 223);
  assert.equal(s.flags[0x136], 255);
  assert.equal(s.variable(0x62f4 / 4), 123);
  assert.equal(s.variable(0x6350 / 4), 65535);
});

test('movie cleanup refreshes the device before issuing an actual bound host stop', async () => {
  const vm = runtime([0, 3]);
  await vm.boot();
  const s = vm.state,
    b = 0x1d8d078,
    events = [];
  const movies = new NoahMovieDevices(s, {
    status(handle) {
      events.push(['status', handle]);
      return 5;
    },
    stop(handle) {
      events.push(['stop', handle]);
    },
  });
  s.put(b + 8, 1, 1);
  s.put(b + 0xdd8, 9, 8);
  s.put(b + 0xd, 1, 1);
  s.put(b + 0xb, 1, 1);
  movies.stop(1);
  assert.deepEqual(events, [
    ['status', 9],
    ['stop', 9],
  ]);
  assert.equal(s.get(b + 0xde0), 5);
  assert.equal(s.get(b + 0x34), 0);
  assert.equal(s.view(b + 0xe, 2).getUint16(0, true), 0x101);
  assert.equal(s.bytes(b + 0xb, 1)[0], 0);
});

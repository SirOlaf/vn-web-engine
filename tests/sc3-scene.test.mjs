import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runtime, literal} from './sc3-fixtures.mjs';

test('text-window wait completes after native fade ticks, without advancing on budget resume', async () => {
  const vm = runtime([1, 0x11, 1, 1, 0x11, 2, 0, 3]);
  await vm.boot();
  assert.equal(vm.runFrame(), 'complete');
  assert.equal(vm.pc(0), 19);
  for (let i = 0; i < 31; i++) vm.runFrame();
  assert.equal(vm.pc(0), 19);
  assert.equal(vm.state.variable(0x839), 248);
  vm.runFrame();
  assert.equal(vm.pc(0), 24);
  assert.equal(vm.state.variable(0x839), 256);
  const paused = runtime([0xfe, ...literal(1), 0xfe, ...literal(2), 0, 3]);
  await paused.boot();
  paused.state.setFlag(0x9c6, 1);
  paused.runFrame(1);
  paused.runFrame(1);
  assert.equal(paused.state.variable(0x839), 8);
});

test('message voice retry preserves operands, then prepares MES glyphs and starts its native slot', async () => {
  const code = [1, 12, 0x81, ...literal(7), ...literal(0), ...literal(17), 0, 3],
    vm = runtime(code);
  const mes = Buffer.alloc(64);
  mes.write('MES\0');
  mes.writeUInt32LE(1, 8);
  mes.writeUInt32LE(32, 12);
  mes.writeUInt32LE(17, 16);
  mes.set([0x81, 0x90, 255], 32);
  vm.assets.messages = async () => mes;
  await vm.boot();
  const s = vm.state;
  s.setVariable(0x4428 / 4, 64);
  s.setVariable(0x442c / 4, 8);
  s.setVariable(0x4384 / 4, 10);
  s.put(0x17add34, 0);
  s.put(0x17abdc0, 1);
  s.put(0x179cd30, 1);
  [0, 10, 10, 0, 1, 100, 0, 0, 24, 24, 200, 600, 0, 0, 32, 32, 16, 16, 8, 4, 0, 0, 0, 0].forEach(
    (v, i) => s.put(0x7fbf00 + i * 2, v, 2),
  );
  const channel = s.bytes(0x5b10b5, 1)[0],
    audio = 0x5a7110 + channel * 0x98;
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.pc(0), 16);
  assert.equal(s.get(audio), 7);
  assert.equal(s.get(audio + 12), 1);
  assert.equal(s.get(0x179cd30), 0);
  s.put(audio + 0x14, 7);
  s.put(audio + 0x24, 1);
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.pc(0), 16 + code.length);
  assert.equal(s.get(0x5b10ac), 1);
  assert.equal(s.get(0x17ac2f0), 1);
  assert.equal(s.flag(0x4bd), 1);
  assert.equal(s.get(0x5a70d8 + channel * 4), 1);
  assert.equal(s.view(0x179e680, 8).getBigUint64(0, true), BigInt(vm.messageAddress(0, 17)));
  assert.equal(s.variable(0x24bc / 4), 65535);
});

test('undefined native text-selection modes fault instead of inventing a slot', async () => {
  const vm = runtime([1, 9, 3]);
  await vm.boot();
  assert.throws(() => vm.runContext(0), /uninitialized native stack/);
});

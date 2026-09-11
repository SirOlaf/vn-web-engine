import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runtime, assignment, literal} from './sc3-fixtures.mjs';

test('scene reveal uses the startup clock and completes only after the final opacity tick', async () => {
  const vm = runtime([1, 13, 0, 0, 3]);
  await vm.boot();
  const s = vm.state;
  assert.equal(s.get(0x17abc0c), 1);
  s.put(0x5b10ac, 1);
  s.put(0x5b10a4, 0x10000);
  s.put(0x5b10a8, 0);
  s.put(0x17ac200, 256);
  s.put(0x5bfb44, 0);
  for (let i = 0; i < 15; i++) {
    assert.equal(vm.runContext(0), 'yield');
    assert.equal(vm.pc(0), 16);
    assert.equal(s.bytes(0x5c20c4, 1)[0], (i + 1) * 16);
  }
  assert.equal(s.get(0x5b10b0), 1);
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.pc(0), 21);
  assert.equal(s.get(0x5b10b0), 2);
  assert.equal(s.bytes(0x5c20c4, 1)[0], 255);
});

test('timed MES expressions use the real context, the previous clock, and run once', async () => {
  const vm = runtime([1, 13, 0, 0, 3]);
  const mes = Buffer.alloc(128);
  mes.write('MES\0');
  mes.writeUInt32LE(1, 8);
  mes.writeUInt32LE(32, 12);
  mes.writeUInt32LE(17, 16);
  mes[32] = 255;
  // Add to a variable so duplicate execution is observable. Also write context word 2.
  mes.set([0x28, 10, ...literal(50).slice(0, -1), 0x17, 0, ...literal(1)], 64);
  mes.set(assignment(0x2d, 2, 77), 96);
  vm.assets.messages = async () => mes;
  await vm.boot();
  const s = vm.state;
  s.put(0x5b10ac, 1);
  s.put(0x5b10a4, 10000);
  s.put(0x17ac200, 1);
  s.put(0x5bfb44, 9999);
  s.put(0x6610cc, 2);
  for (let i = 0; i < 2; i++) {
    s.put(0x7378c0 + i * 4, 1);
    s.put(0x80c350 + i * 8, 0x280000000 + 64 + i * 32, 8);
  }
  vm.runContext(0);
  assert.equal(s.variable(50), 0);
  assert.equal(vm.pc(0), 16);
  vm.runContext(0);
  assert.equal(s.variable(50), 1);
  assert.equal(vm.context(0).getInt32(8, true), 77);
  assert.equal(vm.pc(0), 16);
  vm.runContext(0);
  assert.equal(s.variable(50), 1);
  assert.equal(s.get(0x7378c0), -1);
  assert.equal(s.get(0x7378c4), -1);
});

test('frame input refresh releases a completed message without repeating on budget resume', async () => {
  const vm = runtime([1, 13, 0, 0, 3]);
  await vm.boot();
  const s = vm.state;
  s.setVariable(0x2104 / 4, 1);
  s.setVariable(0x34a8 / 4, 255);
  s.put(0x5b10ac, 1);
  s.put(0x5b10b4, 3, 1);
  s.put(0x5b10a8, 3);
  s.put(0x17ac2b0, 100);
  s.put(0x5b10a4, 1000);
  s.setVariable(0x110b, 8);
  const input = {
    keys: new Set(),
    pressed: new Set(),
    buttons: 0,
    pressedButtons: 0,
    x: 0,
    y: 0,
    wheel: 0,
    inside: false,
  };
  vm.input.update(input);
  vm.runFrame();
  assert.equal(vm.pc(0), 16);
  vm.input.update({...input, keys: new Set(['Enter']), pressed: new Set(['Enter'])});
  vm.runFrame();
  assert.equal(vm.pc(0), 19);
  assert.equal(s.get(0x17ac2b0), 0);
  assert.equal(s.flag(0x771), 1);
  const paused = runtime([0xfe, ...literal(1), 0xfe, ...literal(2), 0, 3]);
  await paused.boot();
  paused.runFrame(1);
  paused.state.put(0x17ac200, 123);
  paused.runFrame(1);
  assert.equal(paused.state.get(0x17ac200), 123);
});

test('fade-out excludes negative timestamps until the final clear and then advances PC', async () => {
  const vm = runtime([1, 13, 1, 0, 3]);
  await vm.boot();
  const s = vm.state;
  s.put(0x5b10ac, 2);
  s.put(0x5b10b4, 2, 1);
  s.put(0x5bfb44, 0);
  s.put(0x5bfb48, -1);
  s.put(0x5c20c4, 16, 1);
  s.put(0x5c20c5, 255, 1);
  vm.runContext(0);
  assert.equal(vm.pc(0), 16);
  assert.equal(s.get(0x5b10b0), 3);
  assert.deepEqual([...s.bytes(0x5c20c4, 2)], [0, 255]);
  vm.runContext(0);
  assert.equal(vm.pc(0), 21);
  assert.equal(s.get(0x5b10b0), 4);
  assert.deepEqual([...s.bytes(0x5c20c4, 2)], [0, 0]);
  assert.equal(s.get(0x5b10ac), 0);
});

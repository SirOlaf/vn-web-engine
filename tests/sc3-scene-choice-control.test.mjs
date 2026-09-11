import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runtime, literal} from './sc3-fixtures.mjs';

test('choice reveal retries without applying row offsets twice, then takes the twelve-byte skip', async () => {
  const vm = runtime([1, 0x13, 0, ...Array(12).fill(255), 0, 3]);
  await vm.boot();
  const s = vm.state;
  s.put(0x17add44, 0);
  s.put(0x660ff0, 2);
  s.put(0x80eb24, 20);
  s.put(0x80eb2c, 30);
  s.put(0x80f250, 600);
  s.put(0x80f258, 590);
  s.put(0x7fbeca, 10, 2);
  s.setVariable(0x2150 / 4, 1);
  s.setVariable(0x20f0 / 4, 0);
  s.put(0x63a480, 0, 1);
  s.put(0x63a481, 1, 1);
  s.put(0x636c40, 5, 2);
  s.put(0x636c42, 7, 2);
  const sounds = [];
  vm.assets.sound = (...v) => sounds.push(v);
  for (let tick = 1; tick <= 16; tick++) {
    assert.equal(vm.runContext(0), 'yield');
    assert.equal(vm.pc(0), 16);
    assert.equal(s.variable(0x20f0 / 4), tick * 16);
    assert.equal(s.flags[0xa0] & 64, 64);
  }
  assert.equal(s.get(0x660ff4), 60);
  assert.equal(s.get(0x7fc938), 590);
  assert.equal(s.get(0x7fc904), 330);
  assert.equal(s.get(0x80f254), 330);
  assert.equal(s.get(0x80f25c), 360);
  assert.equal(s.view(0x636c40, 2).getUint16(0, true), 335);
  assert.equal(s.view(0x636c42, 2).getUint16(0, true), 367);
  assert.equal(sounds.length, 1);
  assert.equal(sounds[0][0], 5);
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.pc(0), 31);
  assert.equal(s.flags[0xa0] & 64, 0);
});

test('choice input uses the pointer grid, confirms, fades, and stores the original row ordinal', async () => {
  const vm = runtime([1, 0x13, 1, 1, 0x13, 2, ...literal(100), 0, 3]);
  await vm.boot();
  const s = vm.state;
  s.put(0x660ff0, 3);
  s.put(0x768710, -1);
  s.put(0x732a20 + 4, 9);
  s.put(0x5b10b0, 2);
  s.put(0x5b10b5, 1, 1);
  s.put(0x5a7110 + 0x98, 12);
  s.put(0x5a711c + 0x98, 13);
  s.setVariable(0x20f0 / 4, 16);
  s.flags[0x136] |= 8;
  const sounds = [];
  vm.assets.sound = (...v) => sounds.push(v);
  vm.input.setRegions([{group: 3, index: 1, x: 100, y: 100, width: 200, height: 60}]);
  const point = {
    keys: new Set(),
    pressed: new Set(),
    inside: true,
    x: 150,
    y: 120,
    buttons: 1,
    pressedButtons: 1,
    wheel: 0,
  };
  for (let click = 0; click < 2; click++) {
    vm.input.update(point);
    vm.input.update({...point, buttons: 0, pressedButtons: 0});
  }
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.pc(0), 19);
  assert.equal(s.get(0x768710), 1);
  assert.equal(s.bytes(0x5b10b4, 1)[0], 2);
  assert.equal(s.get(0x5a7110 + 0x98), -1);
  assert.equal(s.get(0x5a711c + 0x98), 0);
  assert.deepEqual(
    sounds.map((x) => x[0]),
    [1, 2],
  );
  s.put(0x5b10b0, 4);
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.pc(0), 19);
  assert.equal(s.variable(0x20f0 / 4), 0);
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(s.variable(100), 9);
  assert.equal(s.flag(0x771), 1);
  assert.equal(s.flags[0xa0] & 64, 0);
});

test('choice checkpoint success preserves the short continuation PC', async () => {
  const vm = runtime([1, 0x13, 0, 0, 3]);
  await vm.boot();
  const s = vm.state;
  s.setVariable(0x20f0 / 4, 256);
  s.put(0x17add44, 1);
  s.flags[0xa0] = 32;
  for (let i = 0; i < 96; i++) s.put(0x179cc20 + i * 4, i % 48);
  assert.equal(vm.runContext(0), 'yield');
  assert.equal(vm.pc(0), 19);
  assert.equal(s.get(0x17ac1c4), 150);
  assert.equal(s.get(0x8732b4), 2);
  assert.equal(s.variable(0x2100 / 4), 0);
});

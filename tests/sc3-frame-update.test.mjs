import test from 'node:test';
import assert from 'node:assert/strict';
import {runtime, literal} from './sc3-fixtures.mjs';
import {drawGameMenu} from '../dist/engines/mages/games/chaos-head-noah/sc3/game-menu-draw.js';
import {systemMenu} from '../dist/engines/mages/games/chaos-head-noah/sc3/opcodes/system-menu.js';

const menu = (vm, mode) =>
  systemMenu({state: vm.state, input: vm.input, skip: () => {}, byte: () => mode, sound: () => {}});
test('empty history drives the native disabled atlas and all pause-menu input paths', async () => {
  const vm = runtime([0, 0]);
  await vm.boot();
  const s = vm.state;
  for (const count of [0, 1, 400, 0]) {
    s.put(0x810074, count);
    s.setVariable(0x3428 / 4, 0);
    s.setVariable(0x2178 / 4, 32);
    s.flags[0xa0] = 32;
    assert.equal(vm.runFrame(), 'complete');
    assert.equal(s.flag(0x72d), Number(count === 0));
    menu(vm, 0);
    assert.equal(s.variable(0x3428 / 4), count ? 0 : 1);
    s.setVariable(0x3428 / 4, 2);
    const layer = drawGameMenu(s),
      backlog = layer.sprites[2];
    assert.equal(backlog.source.x, count ? 0 : 1356);
    vm.input.hits.set('10/0', 1);
    s.put(0x17add90, 1);
    s.put(0x5a70d4, 0);
    menu(vm, 1);
    assert.equal(!!(s.get(0x5a70d4) & s.get(0x872dd4)), !!count);
    vm.input.hits.clear();
    s.put(0x17add90, 0);
    s.setVariable(0x3428 / 4, 0);
    s.put(0x5a70d4, s.get(0x872dd4));
    menu(vm, 1);
    assert.equal(!!(s.get(0x5a70d4) & s.get(0x872dd4)), !!count);
    s.put(0x5a70d4, 0);
    s.setVariable(0x3428 / 4, 8);
    s.put(0x5a6f74, s.get(0x872dc4));
    menu(vm, 1);
    assert.equal(s.variable(0x3428 / 4), count ? 0 : 1);
    s.put(0x5a6f74, 0);
  }
});
test('frame input and menu flags refresh once, retaining state across a budget continuation', async () => {
  const vm = runtime([0xfe, ...literal(0), 0xfe, ...literal(0), 0, 0]);
  await vm.boot();
  const s = vm.state;
  s.put(0x810074, 0);
  s.put(0x543836, 1, 1);
  s.bytes(0x586a58, 8).fill(255);
  assert.equal(vm.runFrame(1), 'budget');
  assert.equal(s.get(0x586a58), 0);
  assert.equal(s.get(0x586a5c), 0);
  assert.equal(s.bytes(0x543836, 1)[0], 0);
  assert.equal(s.flag(0x72d), 1);
  s.put(0x810074, 1);
  s.put(0x543836, 1, 1);
  s.put(0x586a58, 123);
  assert.equal(vm.runFrame(1), 'budget');
  assert.equal(s.get(0x586a58), 123);
  assert.equal(s.bytes(0x543836, 1)[0], 1);
  assert.equal(s.flag(0x72d), 1);
  vm.runFrame();
  vm.runFrame();
  assert.equal(s.get(0x586a58), 0);
  assert.equal(s.bytes(0x543836, 1)[0], 0);
  assert.equal(s.flag(0x72d), 0);
});
test('auto input suppression expires next pass so menu cancellation works again', async () => {
  const vm = runtime([0, 0]);
  await vm.boot();
  const s = vm.state;
  s.setVariable(0x2104 / 4, 1);
  s.setVariable(0x34a8 / 4, 255);
  s.flags[0xe6] |= 4;
  s.put(0x5a70d4, s.get(0x872de4));
  vm.runFrame();
  assert.equal(s.bytes(0x543836, 1)[0], 1);
  assert.equal(s.get(0x17ac2ec), 4);
  s.put(0x5a70d4, s.get(0x872dd8));
  vm.runFrame();
  assert.equal(s.bytes(0x543836, 1)[0], 0);
  assert.equal(s.get(0x17ac2ec), 0);
  assert.equal(vm.input.query(1), 1);
});
test('wheel backlog bindings are supplied before script input queries and obey the native gate', async () => {
  const vm = runtime([0, 0]);
  await vm.boot();
  const s = vm.state;
  for (const [wheel, gate, expected] of [
    [120, 0, 1],
    [-120, 0, 0],
    [120, 1, 0],
  ]) {
    s.bytes(0x1bae6e0, 256).fill(0);
    s.put(0x17addd0, wheel);
    s.put(0x53208c, gate);
    vm.runFrame();
    assert.equal(vm.input.query(0x1d), expected);
    assert.equal(vm.input.query(0x1d), 0);
  }
});
test('hidden-window toggle runs before opacity and requires a fresh input', async () => {
  const vm = runtime([0, 0]);
  await vm.boot();
  const s = vm.state;
  s.setVariable(0x2104 / 4, 1);
  s.setFlag(0x9c6, 1);
  s.flags[0x9c] |= 8;
  s.put(0x17ac1f8, 1);
  s.put(0x872dec, 0);
  s.put(0x17adc88, 256);
  s.put(0x5a70d4, s.get(0x872dd8));
  vm.runFrame();
  assert.equal(s.flags[0x9b] & 16, 16);
  assert.equal(s.get(0x17adc88), 240);
  s.put(0x5a70d4, 0);
  vm.runFrame();
  assert.equal(s.flags[0x9b] & 16, 16);
  assert.equal(s.get(0x17adc88), 224);
  s.put(0x5a70d4, s.get(0x872dd8));
  vm.runFrame();
  assert.equal(s.flags[0x9b] & 16, 0);
  assert.equal(s.get(0x17adc88), 240);
});
test('interactive delusion advances even without its explicit script selector', async () => {
  const vm = runtime([0, 0]);
  await vm.boot();
  const s = vm.state;
  s.put(0x535830, 1);
  s.put(0x531fa4, 1);
  s.put(0x5358b0, 20000);
  s.put(0x532088, 400);
  s.put(0x535834, 5);
  vm.runFrame();
  assert.equal(s.get(0x5358b0), 20400);
  assert.equal(s.get(0x53589c), 5);
});
test('history reset clears history and refreshes availability on the following native pass', async () => {
  const vm = runtime([16, 0, ...literal(5), 0, 0]);
  await vm.boot();
  const s = vm.state;
  s.put(0x810074, 7);
  s.setFlag(0x72d, 1);
  vm.runFrame();
  assert.equal(s.get(0x810074), 0);
  assert.equal(s.flag(0x72d), 0);
  vm.runFrame();
  assert.equal(s.flag(0x72d), 1);
  s.setVariable(0x3428 / 4, 0);
  menu(vm, 0);
  assert.notEqual(s.variable(0x3428 / 4), 0);
});

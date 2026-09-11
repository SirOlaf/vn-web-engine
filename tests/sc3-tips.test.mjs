import test from 'node:test';
import assert from 'node:assert/strict';
import {runtime} from './sc3-fixtures.mjs';
import {NoahInput} from '../dist/engines/mages/games/chaos-head-noah/sc3/input.js';
import {NoahState} from '../dist/engines/mages/games/chaos-head-noah/sc3/noah-state.js';
test('TIPS native inactive selectors consume only the selector and retain result and state', async () => {
  for (const mode of [3, 5, 127, 255]) {
    const vm = runtime([16, 51, mode, 0, 3]);
    await vm.boot();
    vm.context(0).setInt32(0x1c, 0x12345678, true);
    const state = vm.state.bytes(0x531000, 0x344000).slice();
    assert.equal(vm.runContext(0, 1), 'budget');
    assert.equal(vm.pc(0), 19);
    assert.equal(vm.context(0).getInt32(0x1c, true), 0x12345678);
    assert.deepEqual(vm.state.bytes(0x531000, 0x344000), state);
  }
});
test('TIPS flag synchronization preserves non-flag entry fields and context result', async () => {
  const vm = runtime([16, 51, 4, 0, 3]);
  await vm.boot();
  vm.context(0).setInt32(0x1c, 77, true);
  vm.state.put(0x5b04bc, 3);
  vm.state.auxiliary[0] = 0b11010101;
  vm.state.auxiliary[1] = 1;
  for (let i = 0; i < 3; i++) {
    vm.state.put(0x5a7700 + i * 28 + 16, 0x100);
    vm.state.put(0x5a7700 + i * 28 + 20, 44 + i);
  }
  vm.runContext(0, 1);
  for (let i = 0; i < 3; i++) {
    const bits = ((vm.state.auxiliary[0] | (vm.state.auxiliary[1] << 8)) >> (i * 3)) & 7;
    assert.equal(
      vm.state.get(0x5a7700 + i * 28 + 16),
      (bits & 1) | ((bits & 2) << 1) | ((bits & 4) >> 1),
    );
    assert.equal(vm.state.get(0x5a7700 + i * 28 + 20), 44 + i);
  }
  assert.equal(vm.context(0).getInt32(0x1c, true), 77);
  assert.equal(vm.pc(0), 19);
});
test('pointer regions respect native enable/callback behavior and clear when leaving', () => {
  const s = new NoahState(() => 0),
    input = new NoahInput(s);
  s.initialize();
  input.setRegions([{group: 20, index: 0, x: 10, y: 20, width: 30, height: 40}]);
  const frame = {
    keys: new Set(),
    pressed: new Set(),
    buttons: 1,
    pressedButtons: 1,
    wheel: -120,
    x: 10,
    y: 20,
    inside: true,
  };
  input.update(frame);
  input.update({...frame, buttons: 0});
  input.update(frame);
  input.update({...frame, buttons: 0});
  assert.equal(s.get(0x17add76) & 255, 1);
  s.put(0x17add76, 0, 1);
  assert.equal(input.hit(20, 0, true), false);
  s.put(0x17add76, 1, 1);
  assert.equal(input.hit(20, 0, false), true);
  let activated = 0;
  input.onActivate = () => activated++;
  assert.equal(input.hit(20, 0, true), true);
  assert.equal(activated, 1);
  assert.equal(s.bytes(0x17add72, 1)[0], 1);
  assert.equal(s.get(0x17add90), 1);
  assert.equal(s.get(0x17addd0), -120);
  input.update({...frame, x: 41, buttons: 0, pressedButtons: 0});
  assert.equal(input.hit(20, 0, false), false);
  input.update({...frame, inside: false});
  assert.equal(input.hit(20, 0, false), false);
});

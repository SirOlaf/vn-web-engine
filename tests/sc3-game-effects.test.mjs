import test from 'node:test';
import assert from 'node:assert/strict';
import {runtime, literal, assignment} from './sc3-fixtures.mjs';
import {
  beginCameraMotion,
  advanceCameraMotion,
} from '../dist/engines/mages/games/chaos-head-noah/sc3/effects-camera.js';
import {closeDelusion} from '../dist/engines/mages/games/chaos-head-noah/sc3/effects-delusion.js';
test('registered game-effects opcode completes camera motion across retrying VM passes', async () => {
  const vm = runtime([
    16,
    55,
    80,
    ...[90, -90, 45, 400, 10, 20, 30, 10, 2].flatMap(literal),
    16,
    55,
    12,
    0,
    3,
  ]);
  await vm.boot();
  for (let i = 0; i < 9; i++) {
    vm.runContext(0);
    assert.equal(vm.context(0).getBigUint64(0x158, true), 0x200000000n + 16n + 66n);
  }
  vm.runContext(0);
  assert.deepEqual(
    [0x6c70, 0x6c74, 0x6c78, 0x6c7c, 0x6c8c, 0x6c90, 0x6c94].map((a) => vm.state.variable(a / 4)),
    [16384, -16384, 8192, 400, 10, 20, 30],
  );
});
test('camera expressions finish before native source fields are sampled', async () => {
  const vm = runtime([
    16,
    55,
    13,
    ...literal(90),
    ...assignment(0x28, 0x6c70 / 4, 123),
    ...literal(45),
    0,
    3,
  ]);
  await vm.boot();
  vm.runContext(0);
  assert.equal(vm.state.variable(0x6c70 / 4), 16384);
});
test('camera completion preserves SSE invalid-conversion semantics', () => {
  const s = runtime([]).state;
  s.initialize();
  beginCameraMotion(s, [0, 0, 0, -1, 0, 0, 0], 1, 0);
  assert.equal(advanceCameraMotion(s), false);
  assert.equal(s.variable(0x6c7c / 4), -2147483648);
});
test('delusion completion counts the two native achievement columns separately', () => {
  const s = runtime([]).state;
  s.initialize();
  const ids = [];
  s.put(0x5358d8, 10);
  s.put(0x5358a0, 49);
  s.put(0x535874, 0);
  s.put(0x5358b0, 20000);
  s.auxiliary.fill(1, 100, 188);
  closeDelusion({state: s}, (id) => ids.push(id));
  assert.deepEqual(ids, [29, 30]);
  assert.equal(s.get(0x531fa4), 0);
});

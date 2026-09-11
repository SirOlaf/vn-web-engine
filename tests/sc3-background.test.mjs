import test from 'node:test';
import assert from 'node:assert/strict';
import {runtime, literal} from './sc3-fixtures.mjs';
import {png} from './png-fixtures.mjs';
import {Sc3Runtime} from '../dist/engines/mages/games/chaos-head-noah/sc3/runtime.js';
import {loadBackground} from '../dist/engines/mages/games/chaos-head-noah/sc3/opcodes/background.js';
function invocation(vm) {
  const c = vm.context(0),
    pc = c.getBigUint64(0x158, true);
  return {
    state: vm.state,
    context: c,
    backgroundTextures: vm.backgroundLoader,
    skip: (n) => c.setBigUint64(0x158, c.getBigUint64(0x158, true) + BigInt(n), true),
    expression: () => vm.expression(0),
    yield: () => vm.state.put(0x179cd24, 1),
    retry: () => {
      c.setBigUint64(0x158, pc, true);
      vm.state.put(0x179cd24, 1);
    },
  };
}
test('background image load retains exact phases, flags, dimensions and job zero', async () => {
  const bytes = png({
      width: 3,
      height: 2,
      raw: Buffer.from([0, ...Array(12).fill(100), 0, ...Array(12).fill(200)]),
    }),
    base = runtime([16, 1, ...literal(1), ...literal(214), 0, 3]);
  const requests = [],
    vm = new Sc3Runtime(
      base.platform,
      {
        ...base.assets,
        textures: {
          size: () => bytes.length,
          read: async (bank, id) => {
            requests.push([bank, id]);
            return bytes;
          },
        },
      },
      base.options,
    );
  await vm.boot();
  const s = vm.state;
  s.setVariable(0x3520 / 4, 1);
  s.setVariable(0x3394 / 4, 0);
  const execute = () => {
    s.put(0x179cd24, 0);
    loadBackground(invocation(vm));
  };
  execute();
  assert.equal(s.get(0x17a0cb8), 1);
  assert.equal(vm.pc(0), 16);
  execute();
  assert.equal(s.get(0x587270), 1);
  assert.equal(s.get(0x17a0cb8), 2);
  assert.equal(s.flag(0x4f6), 1);
  await vm.settleLoads();
  vm.publishLoadCompletions();
  assert.deepEqual(requests, [[0, 214]]);
  execute();
  assert.equal(s.get(0x17a0cb8), 8);
  assert.equal(s.get(0x179cd24), 0);
  assert.equal(vm.pc(0), 16);
  assert.equal(s.variable(0x2ee0 / 4), 2);
  assert.equal(s.variable(0x2ee4 / 4), 1);
  assert.deepEqual(
    [...vm.textures.resources.get(1).pending.pixels],
    Array(12).fill(100).concat(Array(12).fill(200)),
  );
  execute();
  assert.equal(s.get(0x17a0cb8), 10);
  execute();
  assert.equal(s.get(0x17a0cb8), 0);
  assert.equal(s.flag(0x4f6), 0);
  assert.equal(s.variable(0x3394 / 4), 0);
  assert.equal(s.variable(0x3404 / 4), 0);
  assert.ok(vm.pc(0) > 16);
});
test('solid-color path creates a full surface and advances PC while preserving phase one', async () => {
  const vm = runtime([16, 1, ...literal(1), ...literal(0xff1973d2), 0, 3]);
  await vm.boot();
  vm.state.setVariable(0x3520 / 4, 2);
  vm.state.setVariable(0x3394 / 4, 0);
  loadBackground(invocation(vm));
  loadBackground(invocation(vm));
  const r = vm.textures.resources.get(2);
  assert.equal(vm.state.get(0x17a0cb8), 1);
  assert.equal(vm.state.get(0x179cd24), 1);
  assert.ok(vm.pc(0) > 16);
  assert.equal(r.image.width, 1920);
  assert.equal(r.image.height, 1080);
  assert.deepEqual([...r.pending.pixels.subarray(0, 4)], [25, 115, 210, 255]);
  assert.deepEqual([...r.pending.pixels.subarray(-4)], [25, 115, 210, 255]);
  assert.equal(vm.state.variable(0x466c / 4), 0xff1973d2 | 0);
});

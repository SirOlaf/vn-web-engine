import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NoahState} from '../dist/engines/mages/games/chaos-head-noah/sc3/noah-state.js';
import {
  scriptLoad,
  LOAD_BUSY,
} from '../dist/engines/mages/games/chaos-head-noah/sc3/script-load.js';
import {runtime, literal} from './sc3-fixtures.mjs';
const loaderFixture = () => {
  const state = new NoahState(() => 0),
    events = [];
  const host = {
    release: (...a) => events.push(['release', ...a]),
    removeSlotContexts: (...a) => events.push(['remove', ...a]),
    start: (...a) => {
      events.push(['start', ...a]);
      return 0;
    },
    take: (...a) => events.push(['take', ...a]),
    rebuildMessages: (...a) => events.push(['map', ...a]),
  };
  return {state, events, host};
};
test('loader advances through separate script/message phases and balances native counter', () => {
  const {state: s, host, events} = loaderFixture();
  s.flags.fill(255);
  s.flags[0xe7] &= ~4;
  s.flags[0x9d] &= ~0x40;
  assert.equal(scriptLoad(s, host, 0, 2, 91), true);
  assert.equal(s.get(0x17a0c84), 1);
  assert.equal(s.variable(0x3404 / 4), 1);
  assert.equal(s.get(0x20ddf0 + 8), 91);
  assert.equal(s.flags[0xa1], 7);
  assert.equal(s.flags[0xa2], 254);
  s.put(0x587270, 1);
  assert.equal(scriptLoad(s, host, 0, 2, 92), true);
  assert.equal(s.get(0x17a0c84), 1);
  s.put(0x587270, 0);
  assert.equal(scriptLoad(s, host, 0, 2, 93), true);
  assert.equal(s.get(0x17a0c84), 3);
  assert.equal(s.variable(0x10f6), 93);
  assert.equal(s.variable(0x3404 / 4), 0);
  assert.equal(scriptLoad(s, host, 0, 2, 94), true);
  assert.equal(s.get(0x17a0c84), 4);
  assert.equal(s.variable(0x3404 / 4), 1);
  assert.equal(scriptLoad(s, host, 0, 2, 94), false);
  assert.equal(s.get(0x17a0c84), 0);
  assert.equal(s.variable(0x3404 / 4), 0);
  assert.equal(s.flags[0x98] & 0x40, 0);
  assert.deepEqual(events, [
    ['remove', 2],
    ['release', 'script', 2],
    ['release', 'messages', 2],
    ['start', 'script', 91, 2],
    ['take', 'script', 2, 0],
    ['start', 'messages', 94, 2],
    ['take', 'messages', 2, 0],
    ['map', 2],
  ]);
});
test('message-only mode preserves scripts; busy transport re-enters phase three', () => {
  const {state: s, host, events} = loaderFixture();
  host.start = () => LOAD_BUSY;
  assert.equal(scriptLoad(s, host, 1, 3, 5), true);
  assert.equal(s.get(0x17a0c84), 3);
  assert.equal(s.variable(0x3404 / 4), 0);
  assert.deepEqual(events, [['release', 'messages', 3]]);
  assert.equal(scriptLoad(s, host, 1, 3, 5), true);
  assert.equal(events.length, 1);
});
test('cancellation before load, while pending, and after error follow distinct native paths', () => {
  const {state: s, host, events} = loaderFixture();
  s.flags[0xe7] = 4;
  assert.equal(scriptLoad(s, host, 0, 1, 2), false);
  assert.equal(s.variable(0x10f5), 65535);
  assert.equal(s.flags[0x98] & 0x40, 0x40);
  assert.equal(
    events.some((e) => e[0] === 'start'),
    false,
  );
  s.put(0x17a0c84, 1);
  s.put(0x587270, 1);
  s.setVariable(0x3404 / 4, 1);
  s.put(0x5872c0, 123, 8);
  s.put(0x587230, 2048);
  assert.equal(scriptLoad(s, host, 0, 1, 2), true);
  assert.equal(s.get(0x17a0c84), 2);
  for (const status of [1, 2]) {
    s.put(0x587270, status);
    assert.equal(scriptLoad(s, host, 0, 1, 2), true);
    assert.equal(s.get(0x17a0c84), 2);
  }
  s.put(0x587270, 3);
  assert.equal(scriptLoad(s, host, 0, 1, 2), false);
  assert.equal(s.get(0x17a0c84), 0);
  assert.equal(s.variable(0x3404 / 4), 0);
  assert.equal(s.get(0x587230), 0);
  assert.equal(s.get(0x5872c0), 0);
  assert.equal(s.flags[0x98] & 0x40, 0);
});
test('completed loads win over cancellation and invalid native job indices fault', () => {
  const {state: s, host} = loaderFixture();
  s.flags[0xe7] = 4;
  s.put(0x17a0c84, 1);
  s.put(0x587270, 0);
  s.setVariable(0x3404 / 4, 1);
  assert.equal(scriptLoad(s, host, 0, 1, 2), true);
  assert.equal(s.get(0x17a0c84), 3);
  s.put(0x17a0c84, 4);
  s.put(0x179e6fc, 0xf4237);
  assert.throws(() => scriptLoad(s, host, 0, 1, 2), /Invalid native loader job/);
});
test('transport promises cannot publish completion until the explicit frame boundary', async () => {
  const vm = runtime([0, 4, 0, ...literal(1), ...literal(2), 0, 3]);
  await vm.boot();
  assert.equal(vm.runFrame(), 'complete');
  const pc = vm.pc(0);
  assert.equal(vm.state.get(0x17a0c84), 1);
  await vm.settleLoads();
  assert.equal(vm.state.get(0x587270), 1);
  assert.equal(vm.scripts[1], undefined);
  vm.publishLoadCompletions();
  assert.equal(vm.state.get(0x587270), 0);
  assert.equal(vm.scripts[1].assetId, 2);
  vm.runFrame();
  assert.equal(vm.pc(0), pc);
  assert.equal(vm.state.get(0x17a0c84), 3);
  vm.runFrame();
  assert.equal(vm.state.get(0x17a0c84), 4);
  await vm.settleLoads();
  vm.publishLoadCompletions();
  vm.runFrame();
  assert.equal(vm.state.get(0x17a0c84), 0);
  assert.ok(vm.messages[1]);
  assert.equal(vm.state.variable(0x3404 / 4), 0);
  assert.ok(vm.pc(0) > pc);
});
test('frame wait re-evaluates its operand and resumes after the native countdown', async () => {
  const vm = runtime([0, 5, ...literal(2), 0, 3]);
  await vm.boot();
  const pc = vm.pc(0);
  vm.runFrame();
  assert.equal(vm.pc(0), pc);
  assert.equal(vm.context(0).getInt32(0x18, true), 2);
  vm.runFrame();
  assert.equal(vm.pc(0), pc);
  assert.equal(vm.context(0).getInt32(0x18, true), 1);
  vm.runFrame();
  assert.ok(vm.pc(0) > pc);
  assert.equal(vm.context(0).getInt32(0x18, true), 0);
});
test('context removal updates the original group, retains neighbors and reuses its ID', async () => {
  const vm = runtime([0, 3]);
  await vm.boot();
  const id = vm.allocateContext(7);
  vm.context(id).setUint32(0x14, 7, true);
  const prev = vm.context(id).getBigUint64(0x140, true),
    next = vm.context(id).getBigUint64(0x148, true);
  vm.releaseContext(id);
  assert.equal(vm.state.get(0x17ab8b0), 1);
  assert.equal(vm.state.get(0x17ab8b0 + 7 * 4), 0);
  assert.equal(vm.context(id).getUint32(0x70, true), id);
  assert.equal(vm.context(id).getBigUint64(0x140, true), prev);
  assert.equal(vm.context(id).getBigUint64(0x148, true), next);
  assert.equal(vm.allocateContext(5), id);
});

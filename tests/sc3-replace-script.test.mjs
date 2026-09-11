import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runtime, assignment, mesBytes} from './sc3-fixtures.mjs';
const script = (code, target) => {
  const b = Buffer.alloc(256);
  b.write('SC3\0');
  b.writeUInt32LE(256, 4);
  b.writeUInt32LE(256, 8);
  b.writeUInt32LE(64, 12);
  b.writeUInt32LE(target, 16);
  b.set(code, 64);
  b.set([0, 3, 0, 0], target);
  return b;
};
async function fixture() {
  const old = script([0, 0x1b, ...assignment(0x28, 40, 91), 1, 0], 128),
    next = script([], 192),
    mes = Buffer.alloc(64);
  mes.write('MES\0');
  mes.writeUInt32LE(3, 8);
  mes.writeUInt32LE(48, 12);
  [17, -7, 17].forEach((id, i) => {
    mes.writeInt32LE(id, 16 + i * 8);
    mes.writeUInt32LE(48 + i, 20 + i * 8);
  });
  const vm = runtime([]),
    requests = [];
  vm.assets.script = async (id) => {
    requests.push(['script', id]);
    return id === 1 ? old : next;
  };
  vm.assets.messages = async (id) => {
    requests.push(['messages', id]);
    return id === 1 ? mesBytes() : mes;
  };
  vm.assets.size = (bank) => (bank === 'script' ? 256 : 64);
  await vm.boot();
  requests.length = 0;
  return {vm, s: vm.state, c: vm.context(0), requests};
}
test('replacement stages both real transports, keeps active code alive, then transfers ownership and rebuilds MES IDs', async () => {
  const {vm, s, c, requests} = await fixture(),
    oldScript = vm.scripts[0],
    oldMessages = vm.messages[0],
    handle = c.getUint32(0x70, true);
  const step = () => {
    s.setVariable(40, -1);
    vm.runFrame();
    assert.equal(s.variable(40), 91);
  };
  step();
  assert.equal(s.get(0x17a0c84), 1);
  assert.equal(vm.pc(0), 64);
  assert.equal(s.variable(0x3404 / 4), 1);
  assert.equal(vm.scripts[0], oldScript);
  await vm.settleLoads();
  assert.equal(s.get(0x587270), 1);
  vm.publishLoadCompletions();
  step();
  assert.equal(s.get(0x17a0c84), 3);
  assert.equal(vm.pc(0), 64);
  assert.equal(s.variable(0x3404 / 4), 0);
  assert.equal(s.variable(0x43d0 / 4), 0);
  step();
  assert.equal(s.get(0x17a0c84), 4);
  assert.equal(s.get(0x20de10), 91);
  assert.equal(vm.messages[0], oldMessages);
  await vm.settleLoads();
  vm.publishLoadCompletions();
  step();
  assert.equal(vm.scripts[0].assetId, 91);
  assert.equal(vm.pc(0), 194);
  assert.equal(c.getUint32(0x70, true), handle);
  assert.equal(s.get(0x17ab8b0), 1);
  assert.equal(s.get(0x17a0c84), 0);
  assert.equal(s.variable(0x3404 / 4), 0);
  assert.equal(s.variable(0x43d0 / 4), 91);
  assert.equal(s.flags[0x98] & 64, 0);
  assert.equal(s.view(0x17adcf0, 8).getBigUint64(0, true), 0n);
  assert.equal(s.view(0x17abc50, 8).getBigUint64(0, true), 0n);
  assert.equal(vm.scripts[8], undefined);
  assert.equal(vm.messages[8], undefined);
  assert.throws(() => vm.dataByte(0x200000000), /Unmapped/);
  assert.throws(() => vm.dataByte(0x280000000), /Unmapped/);
  assert.deepEqual(
    [...vm.messages[0].byId],
    [
      [17, 0],
      [-7, 1],
    ],
  );
  assert.deepEqual(requests, [
    ['script', 91],
    ['messages', 91],
  ]);
});
test('cancellation during either pending transport frees staging buffers but retains the current script and unread label', async () => {
  for (const cancelPhase of [1, 4]) {
    const {vm, s, c} = await fixture();
    vm.runFrame();
    if (cancelPhase === 4) {
      await vm.settleLoads();
      vm.publishLoadCompletions();
      vm.runFrame();
      vm.runFrame();
    }
    s.flags[0xe7] |= 4;
    vm.runFrame();
    assert.equal(s.get(0x17a0c84), 2);
    assert.equal(vm.pc(0), 64);
    await vm.settleLoads();
    vm.publishLoadCompletions();
    vm.runContext(0, 1);
    assert.equal(s.get(0x17a0c84), 0);
    assert.equal(s.variable(0x3404 / 4), 0);
    assert.equal(s.variable(0x43f0 / 4), 65535);
    assert.equal(s.flags[0x98] & 64, 0);
    assert.equal(vm.dataByte(Number(c.getBigUint64(0x158, true))), 1);
    assert.equal(s.get(0x179cd24), 0);
    assert.equal(vm.scripts[0].assetId, 1);
    assert.equal(vm.scripts[8], undefined);
    assert.equal(vm.messages[8], undefined);
    assert.throws(() => vm.dataByte(0x300000000), /Unmapped/);
    if (cancelPhase === 4) assert.throws(() => vm.dataByte(0x301000000), /Unmapped/);
  }
});
test('transport start errors preserve native error code and fault at the following invalid job access', async () => {
  const {vm, s} = await fixture();
  vm.assets.size = () => {
    throw new Error('missing archive asset');
  };
  vm.runFrame();
  assert.equal(s.get(0x179e6fc), 0xf4237);
  assert.equal(s.get(0x17a0c84), 1);
  assert.equal(s.variable(0x3404 / 4), 1);
  assert.equal(s.get(0x20de10), 91);
  assert.throws(() => vm.runFrame(), /Invalid native loader job/);
});

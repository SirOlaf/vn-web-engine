import test from 'node:test';
import assert from 'node:assert/strict';
import {runtime, literal, assignment} from './sc3-fixtures.mjs';
import {png} from './png-fixtures.mjs';
import {Sc3Runtime} from '../dist/engines/mages/games/chaos-head-noah/sc3/runtime.js';
import {loadCharacter} from '../dist/engines/mages/games/chaos-head-noah/sc3/opcodes/character.js';
import {
  compositionResource,
  compositionByte,
  releaseCompositionResource,
} from '../dist/engines/mages/games/chaos-head-noah/sc3/composition-resources.js';
import {RawAssets} from '../dist/engines/mages/games/chaos-head-noah/sc3/raw-assets.js';
function invocation(vm) {
  const s = vm.state,
    c = vm.context(0),
    pc = c.getBigUint64(0x158, true);
  return {
    state: s,
    context: c,
    backgroundTextures: vm.backgroundLoader,
    characterAssets: vm.characterAssets,
    byte: () => {
      const p = c.getBigUint64(0x158, true);
      c.setBigUint64(0x158, p + 1n, true);
      return vm.dataByte(Number(p));
    },
    skip: (n) => c.setBigUint64(0x158, c.getBigUint64(0x158, true) + BigInt(n), true),
    expression: () => vm.expression(0),
    yield: () => s.put(0x179cd24, 1),
    retry: () => {
      c.setBigUint64(0x158, pc, true);
      s.put(0x179cd24, 1);
    },
  };
}
function mesh() {
  const b = Buffer.alloc(228);
  b.write('MVL1');
  b.writeUInt32LE(1, 4);
  b[9] = 16;
  b.write('XFYF0FUFVF', 32);
  b.writeUInt32LE(3, 112);
  b.writeUInt32LE(160, 116);
  b.writeUInt32LE(3, 120);
  b.writeUInt32LE(220, 124);
  b.set([0, 0, 1, 0, 2, 0], 220);
  return b;
}
async function fixture(code) {
  const atlas = png({width: 1, height: 1, raw: Buffer.from([0, 17, 31, 53, 255])}),
    mvl = mesh(),
    requests = [],
    base = runtime(code);
  const vm = new Sc3Runtime(
    base.platform,
    {
      ...base.assets,
      textures: {
        size: (bank, id) => (id % 2 ? mvl.length : atlas.length),
        read: async (bank, id) => {
          requests.push([bank, id]);
          return id % 2 ? mvl : atlas;
        },
      },
    },
    base.options,
  );
  await vm.boot();
  const s = vm.state;
  s.setVariable(0xd7a, 10);
  s.put(0x57aad0 + 2 * 4, 5);
  s.setVariable(0x3394 / 4, 0);
  s.flags[0xe7] = 0;
  s.flags[0x98] = 255;
  s.setVariable(0x13f5, 65535);
  return {
    vm,
    s,
    requests,
    mvl,
    execute: () => {
      s.put(0x179cd24, 0);
      loadCharacter(invocation(vm));
    },
  };
}
test('character loader publishes independent atlas/MVL jobs, follows every success phase and owns mesh copies', async () => {
  const {vm, s, requests, mvl, execute} = await fixture([
    16,
    5,
    1,
    ...assignment(0x28, 40, 1),
    ...assignment(0x28, 41, 0x701d8),
    0,
    3,
  ]);
  s.put(0x17abe94, 1);
  s.put(0x17a0cdc, 1);
  const end = 16 + 3 + assignment(0x28, 40, 1).length + assignment(0x28, 41, 0x701d8).length;
  const step = () => {
    s.setVariable(40, 123);
    s.setVariable(41, 456);
    execute();
    assert.equal(s.variable(40), 1);
    assert.equal(s.variable(41), 0x701d8);
  };
  step();
  assert.equal(s.get(0x17a0cc0), 1);
  assert.equal(vm.pc(0), 16);
  step();
  assert.equal(s.get(0x17a0cc0), 2);
  assert.equal(s.variable(0x13f5), 0x100701d8);
  assert.equal(s.variable(0x13f8), 7);
  assert.equal(s.get(0x587270), 1);
  assert.equal(s.variable(0x3404 / 4), 1);
  step();
  assert.equal(s.get(0x17a0cc0), 7);
  assert.equal(s.get(0x587274), 1);
  assert.equal(s.variable(0x3404 / 4), 2);
  await vm.settleLoads();
  assert.equal(s.get(0x587270), 1);
  assert.equal(s.get(0x587274), 1);
  assert.deepEqual(requests, [
    [1, 0x1fc],
    [1, 0x1fd],
  ]);
  vm.publishLoadCompletions();
  assert.equal(s.get(0x587270), 0);
  assert.equal(s.get(0x587274), 0);
  step();
  assert.equal(s.get(0x17a0cc0), 6);
  assert.equal(s.variable(0x3404 / 4), 2);
  assert.deepEqual([...vm.textures.resources.get(10).pending.pixels], [17, 31, 53, 255]);
  step();
  assert.equal(s.get(0x17a0cc0), 3);
  assert.equal(s.variable(0x3404 / 4), 1);
  const pointer = Number(s.view(0x5872c8, 8).getBigUint64(0, true));
  step();
  assert.equal(s.get(0x17a0cc0), 0);
  assert.equal(vm.pc(0), end);
  assert.equal(s.get(0x179cd24), 0);
  assert.equal(s.variable(0x3394 / 4), 0);
  assert.equal(s.variable(0x3404 / 4), 0);
  assert.equal(s.flags[0x98], 191);
  assert.equal(vm.characterAssets.byte(pointer), undefined);
  const resource = compositionResource(s, 5);
  assert.deepEqual([...resource.bytes], [...mvl]);
  assert.equal(compositionResource(s, 2), undefined);
  mvl.fill(0);
  assert.equal(resource.header[0], 77);
  assert.equal(new DataView(resource.meshes.buffer).getUint32(20, true), 0);
  assert.equal(new DataView(resource.meshes.buffer).getUint32(28, true), 60);
  for (const pointer of resource.allocations)
    assert.notEqual(compositionByte(s, pointer), undefined);
  releaseCompositionResource(s, 13);
  assert.equal(compositionResource(s, 5), undefined);
  for (const pointer of resource.allocations) assert.equal(compositionByte(s, pointer), undefined);
});
test('character gate does not evaluate operands; cache exits retain phase and selector-specific PC', async () => {
  for (const selector of [0, 1, 255]) {
    const {vm, s, execute} = await fixture([
      16,
      5,
      selector,
      ...assignment(0x28, 40, 1),
      ...literal(0x800001d8),
      0,
      3,
    ]);
    s.put(0x17a0cc0, 1);
    s.put(0x81007c, 1);
    s.setVariable(40, 123);
    execute();
    assert.equal(s.variable(40), 123);
    assert.equal(vm.pc(0), 16);
    s.put(0x81007c, 0);
    s.setVariable(0x13f5, 0x100001d8);
    execute();
    assert.equal(s.variable(40), 1);
    assert.equal(s.variable(0x13f8), -32768);
    assert.equal(s.get(0x17a0cc0), 1);
    assert.equal(
      vm.pc(0),
      16 + 3 + assignment(0x28, 40, 1).length + literal(0).length + (selector === 0 ? 2 : 0),
    );
  }
});
test('character cancellation waits one phase and decrements exactly once, keeping pending job slots', async () => {
  for (const phase of [3, 7]) {
    const {vm, s, execute} = await fixture([16, 5, 0, ...literal(1), ...literal(20), 0, 3]);
    s.put(0x17a0cc0, phase);
    s.setVariable(0x3404 / 4, 2);
    s.setVariable(0x3394 / 4, 1);
    s.flags[0xe7] = 4;
    s.put(0x587270, 1);
    s.put(0x587274, 2);
    execute();
    assert.equal(s.get(0x17a0cc0), 4);
    assert.equal(vm.pc(0), 16);
    execute();
    assert.equal(s.get(0x17a0cc0), 0);
    assert.equal(s.variable(0x3404 / 4), 1);
    assert.equal(s.variable(0x3394 / 4), 0);
    assert.equal(s.get(0x587270), 1);
    assert.equal(s.get(0x587274), 2);
  }
});
test('owned archive channels publish independently and failed starts preserve slots', async () => {
  const vm = runtime([]),
    s = vm.state,
    source = {size: () => 3, read: async () => new Uint8Array([4, 5, 6])},
    a = new RawAssets(s, source, 0),
    b = new RawAssets(s, source, 1);
  assert.equal(a.start(1, 0), 0);
  assert.equal(b.start(1, 1), 1);
  assert.equal(b.start(1, 1), 0xf4236);
  await Promise.all([a.settle(), b.settle()]);
  a.publish();
  assert.equal(s.get(0x587270), 0);
  assert.equal(s.get(0x587274), 1);
  b.publish();
  assert.equal(s.get(0x587274), 0);
  const pa = Number(s.view(0x5872c0, 8).getBigUint64(0, true)),
    pb = Number(s.view(0x5872c8, 8).getBigUint64(0, true));
  assert.notEqual(pa, pb);
  assert.deepEqual([...b.read(pb, 3)], [4, 5, 6]);
  a.release(pa);
  assert.equal(b.byte(pb), 4);
  const bad = new RawAssets(s, undefined, 2);
  assert.equal(bad.start(1, 1), 0xf4237);
  assert.equal(s.get(0x587278), 0);
});
test('registered character and scene-wave opcodes resume through the VM and stop at the next unsupported opcode', async () => {
  const code = [
      16,
      5,
      0,
      ...literal(1),
      ...literal(20),
      16,
      0x30,
      0,
      1,
      0x12,
      0,
      0,
      0,
      ...literal(0),
      0,
      0xff,
    ],
    {vm, s} = await fixture(code);
  for (const phase of [1, 2, 7]) {
    assert.equal(vm.runContext(0), 'yield');
    assert.equal(s.get(0x17a0cc0), phase);
  }
  await vm.settleLoads();
  vm.publishLoadCompletions();
  for (const phase of [6, 3]) {
    assert.equal(vm.runContext(0), 'yield');
    assert.equal(s.get(0x17a0cc0), phase);
  }
  s.setVariable(0x4330 / 4, 65535);
  s.put(0x545654, 7);
  assert.throws(() => vm.runContext(0), /Unimplemented opcode 00\/ff/);
  assert.equal(vm.pc(0), 16 + code.length - 2);
  assert.equal(s.get(0x545654), 0);
  assert.equal(s.get(0x17a0cc0), 0);
  assert.ok(compositionResource(s, 5));
});

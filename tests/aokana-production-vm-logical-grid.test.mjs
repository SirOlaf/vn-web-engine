import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM D0 grid callbacks share one data registry and actual BP memory', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, data, core, memory, child, definitions, fragments, invoke} = fixture;
  const call = async (secondary, args, expected) => {
    assert.equal(await invoke(0xd0, secondary, args, 0), 1);
    assert.equal(pop32(child.state), expected);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  };
  try {
    assert.equal(data.graph, graph);
    assert.equal(core.data, data);
    assert.equal(core.memory, data.memory);
    assert.equal(core.fragments.data, data);
    assert.equal(core.fragments.graph, graph);
    assert.equal(data.memory, memory);
    const gridSlots = [
      0x00, 0x01, 0x04, 0x05, 0x10, 0x11, 0x12, 0x14, 0x15, 0x16, 0x17, 0x18, 0x20, 0x21, 0x22,
      0x23, 0x28, 0x2c, 0x2d,
    ];
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0xd0 && gridSlots.includes(secondary))
        .map(({secondary}) => secondary),
      gridSlots,
    );
    assert.equal(
      data
        .nativeDefinitions()
        .filter(({primary, secondary}) => primary === 0xd0 && gridSlots.includes(secondary)).length,
      19,
    );
    assert.equal(fragments.nativeDefinitions().length, definitions.length);

    const view = new DataView(memory.globalMemory.buffer);
    memory.globalMemory.fill(0, 0x400, 0x400 + 3 * 3 * 16);
    view.setUint32(0x100, 0xffffffff, true);
    await call(0x00, [0x100, 0, 1], 1);
    const id = view.getUint32(0x100, true);
    assert.equal(id, 0);
    assert.equal(data.grids.get(id)?.verticalDivisor, 1);
    await call(0x04, [id, 3, 3, 0x400], 0);
    assert.deepEqual(data.grids.get(id)?.dimensions(), {width: 3, height: 3});

    view.setUint32(0x104, 0xffffffff, true);
    await call(0x10, [0x104, id], 0);
    const agent = view.getUint32(0x104, true);
    assert.equal(agent, 0x20000000);
    await call(0x14, [id, agent, 1, 1], 0);
    await call(0x20, [id, agent, 1, 2, -1, -1], 0);
    await call(0x21, [0x200, 0x108, id, agent, 0, 0], 0);
    assert.equal(view.getInt32(0x108, true), 2);
    assert.deepEqual([view.getInt32(0x200, true), view.getInt32(0x204, true)], [2, 4]);
    await call(0x23, [0x300, 0x108, id, agent], 0);
    assert.equal(view.getInt32(0x108, true), 8);
    assert.deepEqual(
      Array.from({length: 16}, (_, index) => view.getInt32(0x300 + index * 4, true)),
      [0, 0, 1, 0, 2, 0, 0, 1, 2, 1, 0, 2, 1, 2, 2, 2],
    );

    await call(0x12, [id, agent], 0);
    await call(0x11, [id, agent], 0);
    await call(0x01, [id], 1);
    assert.equal(data.grids.get(id), undefined);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted D0 evaluator callbacks share grid, allocator, processing and BP owners', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, data, core, memory, child, definitions, invoke} = fixture;
  const view = new DataView(memory.globalMemory.buffer);
  const call = async (secondary, args, expected = 0, pushed = true) => {
    assert.equal(await invoke(0xd0, secondary, args, 0), Number(pushed));
    if (pushed) assert.equal(pop32(child.state), expected);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  };
  try {
    assert.equal(core.data, data);
    assert.equal(core.memory, data.memory);
    assert.equal(data.gridWorkers.grids, data.grids);
    assert.equal(data.gridWorkers.allocator, graph.allocator);
    assert.equal(data.gridWorkers.mainProcessing, graph.resource.processing);
    const slots = [0x80, 0x81, 0x84, 0x87, 0x88, 0x8a, 0x8c, 0x8d, 0x8e];
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0xd0 && slots.includes(secondary))
        .map(({secondary}) => secondary),
      slots,
    );

    memory.globalMemory.fill(0, 0x400, 0x400 + 5 * 16);
    await call(0x00, [0x100, 0, 1], 1);
    const gridId = view.getUint32(0x100, true);
    assert.equal(gridId, 0);
    await call(0x04, [gridId, 5, 1, 0x400]);
    const agentIds = [];
    for (let index = 0; index < 2; index++) {
      await call(0x10, [0x110, gridId]);
      const agentId = view.getUint32(0x110, true);
      agentIds.push(agentId);
      await call(0x14, [gridId, agentId, index * 4, 0]);
      await call(0x18, [gridId, agentId, index === 0 ? 5 : 4]);
    }
    assert.deepEqual(agentIds, [0x20000000, 0x20000001]);
    const actors = 0x1000;
    memory.globalMemory.fill(0, actors, actors + 2 * 0x834);
    for (let index = 0; index < 2; index++) {
      for (const [word, value] of [
        [0, agentIds[index]],
        [1, 1 << index],
        [2, 0],
        [3, -1],
        [7, 10],
        [8, 20],
        [0x8d, 1],
        [0x8e, 1],
        [0x95, 1],
      ])
        view.setInt32(actors + index * 0x834 + word * 4, value, true);
    }

    view.setUint32(0x120, 0xffffffff, true);
    await call(0x80, [0x120], 0, false);
    const workerId = view.getUint32(0x120, true);
    assert.equal(workerId, 1);
    await call(0x84, [workerId, 3]);
    await call(0x88, [workerId, gridId, 2, actors, 0]);
    memory.globalMemory.fill(0xa5, 0x3000, 0x3000 + 0x834);
    await call(0x8e, [0x3000, workerId, 0]);
    assert.deepEqual(
      [0, 1, 2, 3, 7, 8].map((word) => view.getInt32(0x3000 + word * 4, true)),
      [agentIds[0] | 0, 1, 0, -1, 10, 20],
    );
    assert.equal(view.getInt32(0x3000 + 0x20d * 4, true), 0);
    assert.equal(view.getInt32(0x3000 + 0x20e * 4, true), 0);
    await call(0x8c, [workerId, gridId]);
    await call(0x8d, [workerId, 1, actors + 0x834, 0, 0]);

    memory.globalMemory.fill(0x55, 0x4000, 0x4000 + 4 * 28);
    view.setUint32(0x3ff0, 0xaaaaaaaa, true);
    await call(0x8a, [0x4000, 0x3ff0, workerId, 0, 3]);
    assert.equal(data.gridWorkers.hasPendingWork(), true);
    await data.gridWorkers.joinPendingWork();
    assert.equal(data.gridWorkers.hasPendingWork(), false);
    assert.equal(view.getUint32(0x3ff0, true), 3);
    assert.deepEqual(
      Array.from({length: 21}, (_, word) => view.getInt32(0x4000 + word * 4, true)),
      [1, 0, 3, -1, -1, -1, 1, 1, 0, 2, -1, -1, -1, 0, 1, 0, 1, -1, -1, -1, 0],
    );
    assert.equal(view.getUint32(0x4000 + 3 * 28, true), 0x55555555);
    view.setUint32(0x130, 0xaaaaaaaa, true);
    await call(0x87, [0x130, workerId]);
    assert.equal(view.getUint32(0x130, true), 0);
    await call(0x81, [workerId]);
    for (const agentId of agentIds) await call(0x11, [gridId, agentId]);
    await call(0x01, [gridId], 1);
    assert.equal(data.grids.get(gridId), undefined);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});

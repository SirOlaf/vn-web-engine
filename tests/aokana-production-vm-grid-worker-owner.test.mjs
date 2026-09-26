import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted grid worker owner drains queued valid work before grid and BP teardown', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, data, core, memory, child, invoke} = fixture;
  const view = new DataView(memory.globalMemory.buffer);
  const pointer = (offset) => ({bytes: memory.globalMemory, offset});
  const call = async (secondary, args, expected) => {
    assert.equal(await invoke(0xd0, secondary, args, 0), 1);
    assert.equal(pop32(child.state), expected);
    assert.equal(child.state.stackIndex, 0);
  };
  try {
    assert.equal(data.gridWorkers.allocator, graph.allocator);
    assert.equal(data.gridWorkers.mainProcessing, graph.resource.processing);
    assert.equal(data.gridWorkers.grids, data.grids);
    assert.equal(core.data, data);
    assert.equal(core.memory, data.memory);
    assert.equal(data.memory, memory);

    memory.globalMemory.fill(0, 0x400, 0x400 + 16);
    await call(0x00, [0x100, 0, 1], 1);
    const gridId = view.getUint32(0x100, true);
    assert.equal(gridId, 0);
    await call(0x04, [gridId, 1, 1, 0x400], 0);
    memory.globalMemory.fill(0, 0x500, 0x500 + 0x834);
    assert.equal(data.gridWorkers.create(pointer(0x180)), 0);
    const workerId = view.getUint32(0x180, true);
    assert.equal(workerId, 1);
    assert.equal(data.gridWorkers.initialize(workerId, gridId, 1, pointer(0x500), 1), 0);
    assert.equal(data.gridWorkers.hasPendingWork(), true);
    assert.equal(data.gridWorkers.create(pointer(0x184)), 0);
    assert.equal(view.getUint32(0x184, true), 2);

    await core.close();
    await data.gridWorkers.closeAndJoin();
    assert.equal(data.gridWorkers.admissionClosed, true);
    assert.equal(data.gridWorkers.quiesced, true);
    assert.equal(data.grids.get(gridId), undefined);
    assert.equal(core.scheduler.firstThread, null);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});

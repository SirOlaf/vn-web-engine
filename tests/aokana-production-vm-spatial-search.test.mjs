import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted D0 spatial search shares the registry and completes its native seed-only worker path', async () => {
  const fixture = await createMountedVmFixture({resourceWorkerCount: 3});
  const {graph, data, memory, child, definitions, invoke} = fixture;
  const view = new DataView(memory.globalMemory.buffer);
  const call = async (secondary, args, expected) => {
    assert.equal(await invoke(0xd0, secondary, args, 0), 1);
    assert.equal(pop32(child.state), expected);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  };
  try {
    assert.equal(data.graph, graph);
    assert.equal(data.gridWorkers.mainProcessing, graph.resource.processing);
    assert.equal(graph.resource.processing.allocator, graph.allocator);
    assert.equal(graph.resource.processing.capacity, 3);
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0xd0 && secondary === 0x72)
        .map(({secondary}) => secondary),
      [0x72],
    );
    assert.equal(
      data
        .nativeDefinitions()
        .filter(({primary, secondary}) => primary === 0xd0 && secondary === 0x72).length,
      1,
    );

    view.setUint32(0x100, 0xffffffff, true);
    await call(0x40, [0x100], 0);
    const id = view.getUint32(0x100, true);
    assert.equal(id, 1);
    const record = (x) => [x * 65536, 0, 0, 65536, 0, 0, 65536, 0, 0];
    await call(0x60, [id, 0, ...record(0), 1, 7], 0);
    await call(0x60, [id, 1, ...record(2), 1, 8], 0);

    for (const distributed of [0, 1]) {
      memory.globalMemory.fill(0x55, 0x200, 0x240);
      await call(
        0x72,
        [0x220, 0x200, id, 0, 1, 4 * 65536, 65536, 0x103, 7, 0x20, distributed],
        0x16,
      );
      assert.deepEqual(memory.globalMemory.subarray(0x200, 0x240), new Uint8Array(0x40).fill(0x55));
      assert.equal(graph.resource.processing.distributedFlag, 0);
      for (let worker = 0; worker < 3; worker++)
        assert.equal(graph.resource.processing.workerState(worker).phase, 'idle');
    }

    await call(0x61, [id, 1], 0);
    await call(0x61, [id, 0], 0);
    await call(0x41, [id], 0);
  } finally {
    await fixture.close();
  }
});

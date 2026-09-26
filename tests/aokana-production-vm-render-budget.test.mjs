import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted pre-device CPU setup publishes the initial shared render budget once', async () => {
  let tick = 0;
  let timestamps = 0;
  const affinity = [];
  const cpuHost = {
    cpuid(leaf) {
      switch (leaf) {
        case 0:
          return [1, 0x68747541, 0x444d4163, 0x69746e65]; // AuthenticAMD.
        case 1:
          return [0x600, 0, 0, 1 << 26];
        case 0x80000000:
          return [0x80000006, 0, 0, 0];
        case 0x80000005:
          return [0, 0, (64 << 24) | 0x80040, 0];
        case 0x80000006:
          return [0, 0, (512 << 16) | 0x6040, 0];
        default:
          return [0, 0, 0, 0];
      }
    },
    readTimestampCounter: () => BigInt(timestamps++ % 2) * 2000000000n,
    setCurrentThreadAffinity(mask) {
      affinity.push(mask);
      return 3n;
    },
    logicalProcessorCount: () => 4,
    logicalProcessorInformation: () => [{relationship: 0, processorMask: 3n}],
  };
  const fixture = await createMountedVmFixture({cpuHost, performanceNow: () => (tick += 125)});
  const {graph, child, definitions, invoke} = fixture;
  try {
    assert.equal(graph.controller.manager, graph.manager);
    assert.equal(graph.controller.display, graph.display);
    assert.equal(graph.controller.cpu.host, cpuHost);
    assert.equal(graph.controller.cpu.clock, graph.clock);
    assert.equal(graph.device.isPresent(), false);
    assert.equal(graph.manager.environment.displayContext, null);
    assert.equal(
      definitions.filter(({primary, secondary}) => primary === 0x80 && secondary === 0x0b).length,
      1,
    );

    assert.equal(graph.prepareRenderPixelBudget(), 6406);
    assert.equal(graph.manager.renderPixelBudget, 6406);
    assert.deepEqual(affinity, [1n, 3n]);
    assert.equal(graph.prepareRenderPixelBudget(), 6406);
    assert.deepEqual(affinity, [1n, 3n]);
    assert.equal(timestamps, 2);

    assert.equal(await invoke(0x80, 0x0b, [], 0), 1);
    assert.equal(pop32(child.state), 6406);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
    assert.equal(graph.device.isPresent(), false);
    assert.equal(graph.manager.environment.displayContext, null);
  } finally {
    await fixture.close();
  }
});

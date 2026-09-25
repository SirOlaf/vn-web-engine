import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted CPU callbacks read one explicitly initialized graph CPU profile', async () => {
  const words = (bytes) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return Array.from({length: bytes.length / 4}, (_, index) => view.getUint32(index * 4, true));
  };
  const [vendorB, vendorD, vendorC] = words(new TextEncoder().encode('GenuineIntel'));
  const report = new Uint8Array(16);
  report[0] = 1;
  report.set([0x2c, 0x7a, 0x47], 1);
  const brand = new Uint8Array(48);
  brand.set(new TextEncoder().encode(' Test CPU '));
  const extra = new Map();
  for (let index = 0; index < 3; index++)
    extra.set(0x80000002 + index, words(brand.subarray(index * 16, index * 16 + 16)));
  let timestamp = 0;
  let tick = 0;
  const affinity = [];
  const cpuHost = {
    cpuid(leaf) {
      if (extra.has(leaf)) return extra.get(leaf);
      switch (leaf) {
        case 0:
          return [4, vendorB, vendorC, vendorD];
        case 1:
          return [0x000a0675, 0x123456ab, 0, 1 << 26];
        case 2:
          return words(report);
        case 0x80000000:
          return [0x80000006, 0, 0, 0];
        case 0x80000001:
          return [0, 0x1234beef, 0, 0];
        default:
          return [0, 0, 0, 0];
      }
    },
    readTimestampCounter() {
      return timestamp++ % 2 === 0 ? 10000n : 2500010000n;
    },
    setCurrentThreadAffinity(mask) {
      affinity.push(mask);
      return 0x100000003n;
    },
    logicalProcessorCount: () => 12,
    logicalProcessorInformation: () => [
      {relationship: 3, processorMask: 0xffn},
      {relationship: 0, processorMask: 0x8000000000000005n},
      {relationship: 0, processorMask: 0xffffn},
    ],
  };
  const fixture = await createMountedVmFixture({cpuHost, performanceNow: () => (tick += 125)});
  const {graph, memory, child, definitions, invoke} = fixture;
  try {
    assert.equal(graph.cpuHost, cpuHost);
    assert.equal(graph.controller.cpu.host, cpuHost);
    assert.equal(graph.controller.cpu.clock, graph.clock);
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) => (primary === 0x80 || primary === 0x81) && secondary === 0x0a,
        )
        .map(({primary, secondary}) => [primary, secondary]),
      [
        [0x80, 0x0a],
        [0x81, 0x0a],
      ],
    );
    assert.equal(graph.controller.cpu.initialize(), true);
    assert.deepEqual(affinity, [1n, 3n]);
    memory.globalMemory.fill(0xcc, 0x1ff, 0x242);
    assert.equal(await invoke(0x80, 0x0a, [0x200], 0), 0);
    const view = new DataView(memory.globalMemory.buffer);
    assert.deepEqual(
      Array.from({length: 16}, (_, index) => view.getUint32(0x200 + index * 4, true)),
      [0, 6, 0xa7, 5, 0xab, 0x40080020, 0x40080100, 0x40082000, 2500, 12, 3, 0, 0, 0, 0, 0],
    );
    assert.equal(memory.globalMemory[0x1ff], 0xcc);
    assert.equal(memory.globalMemory[0x240], 0xcc);
    assert.equal(child.state.stackIndex, 0);
    memory.globalMemory.fill(0xcc, 0x27f, 0x290);
    assert.equal(await invoke(0x81, 0x0a, [0x280], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.deepEqual(
      [...memory.globalMemory.subarray(0x280, 0x289)],
      [...new TextEncoder().encode('Test CPU\0')],
    );
    assert.equal(memory.globalMemory[0x27f], 0xcc);
    assert.equal(memory.globalMemory[0x289], 0xcc);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});

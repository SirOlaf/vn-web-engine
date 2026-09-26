import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM shares diagnostic counts and pooled allocation records with E0 file writers', async () => {
  const fixture = await createMountedVmFixture();
  const {data, graph, memory, mounted, child, definitions, fragments, invoke} = fixture;
  const originalInstructionStart = child.state.instructionStart;
  try {
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) =>
            primary === 0xe0 && [0x90, 0x91, 0x92, 0x93, 0xc0, 0xc2].includes(secondary),
        )
        .map(({secondary}) => secondary),
      [0x90, 0x91, 0x93, 0xc0, 0x92, 0xc2],
    );
    assert.equal(fragments.nativeDefinitions().length, definitions.length);
    assert.equal(graph.resource.files.specialFolders, graph.folders);
    assert.equal(graph.folders.roots, graph.resource.resources.configuration);
    assert.equal(data.counts.banks.length, 10);
    assert.equal(data.allocations.records.length, 0);
    memory.globalMemory.set(new TextEncoder().encode('counts.log\0'), 0x100);
    memory.globalMemory.set(new TextEncoder().encode('allocations.log\0'), 0x120);
    memory.globalMemory.fill(0xa5, 0x180, 0x190);
    assert.equal(await invoke(0xe0, 0x93, [0x9001, 1], 0), 1);
    assert.equal(pop32(child.state), 0);
    assert.equal(data.counts.banks.find(({bank}) => bank === 0x90).flags.bytes[4], 1);
    assert.equal(await invoke(0xe0, 0x91, [0x180], 0), 1);
    assert.equal(pop32(child.state), 0);
    assert.deepEqual(memory.globalMemory.subarray(0x180, 0x190), new Uint8Array(16).fill(0xa5));
    assert.equal(await invoke(0xe0, 0x90, [], 0), 0);
    assert.equal(await invoke(0xe0, 0x92, [0x100, 0], 0), 1);
    assert.equal(pop32(child.state), 0);
    const countsFile = await mounted.open('/game/counts.log');
    assert.equal(countsFile.size, 0);
    assert.deepEqual(await countsFile.read(0, countsFile.size), new Uint8Array());

    assert.equal(await invoke(0xe0, 0xc0, [1], 0), 0);
    assert.equal(data.allocations.enabled, 1);
    const module = child.state.modules[0];
    assert.ok(module);
    child.state.instructionStart = module.base + 1;
    assert.equal(await invoke(0x80, 0x20, [16], 0), 1);
    const first = pop32(child.state);
    child.state.instructionStart = module.base + 2;
    assert.equal(await invoke(0x80, 0x20, [24], 0), 1);
    const second = pop32(child.state);
    assert.deepEqual(
      data.allocations.records.map(({address}) => address),
      [second, first],
    );
    assert.equal(await invoke(0xe0, 0xc2, [0x120, 0], 0), 1);
    assert.equal(pop32(child.state), 0);
    const allocationFile = await mounted.open('/game/allocations.log');
    const bytes = await allocationFile.read(0, allocationFile.size);
    const hex = (value) => (value >>> 0).toString(16).toUpperCase().padStart(8, '0');
    const expected =
      `Address [ $${hex(second)} ] : Size [ 24 ] : Thread [ ${child.state.id} ] , Program [ ipl._bp ] , IP [ $00000002 ]\n` +
      `Address [ $${hex(first)} ] : Size [ 16 ] : Thread [ ${child.state.id} ] , Program [ ipl._bp ] , IP [ $00000001 ]\n`;
    assert.deepEqual(bytes, new TextEncoder().encode(expected));
    assert.equal(child.state.stackIndex, 0);

    assert.equal(await invoke(0x80, 0x21, [second], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(await invoke(0x80, 0x21, [first], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(data.allocations.records.length, 0);
    assert.equal(child.state.stackIndex, 0);
  } finally {
    child.state.instructionStart = originalInstructionStart;
    data.allocations.enabled = 0;
    await fixture.close();
  }
});

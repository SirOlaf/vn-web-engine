import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM encodes and decodes BP buffers through the shared codec worker', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, memory, child, definitions, fragments, invoke} = fixture;
  try {
    assert.equal(graph.codecWorkers.admissionClosed, false);
    assert.equal(graph.resource.loading.resources, graph.resource.resources);
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x80 && [0xc0, 0xcf].includes(secondary))
        .map(({secondary}) => secondary),
      [0xc0, 0xcf],
    );
    assert.equal(fragments.nativeDefinitions().length, definitions.length);
    const plain = new TextEncoder().encode('AB'.repeat(20));
    memory.globalMemory.set(plain, 0x100);
    memory.globalMemory.fill(0xa5, 0x200, 0x280);
    assert.equal(await invoke(0x80, 0xc0, [0x200, 0x100, plain.length], 2), 0);
    assert.equal(graph.resource.loading.activeProcedures, 1);
    assert.equal(await child.pollProcess(false), 0);
    assert.equal(child.state.stackIndex, 0);
    await graph.codecWorkers.joinPending();
    assert.equal(graph.codecWorkers.hasPendingWork(), false);
    assert.equal(await child.pollProcess(false), 1);
    assert.equal(child.process, null);
    assert.equal(graph.resource.loading.activeProcedures, 0);
    const encodedLength = pop32(child.state);
    assert.equal(encodedLength, 41);
    assert.equal(child.state.stackIndex, 0);
    const encoded = memory.globalMemory.subarray(0x200, 0x200 + encodedLength);
    const expected = new Uint8Array(41);
    const header = new DataView(expected.buffer);
    expected.set(new TextEncoder().encode('SDC FORMAT 1.00\0'));
    header.setUint32(20, 9, true);
    header.setUint32(24, plain.length, true);
    header.setUint16(28, 1063, true);
    header.setUint16(30, 203, true);
    expected.set([1, 155, 196, 222, 66, 128, 205, 75, 15], 32);
    assert.deepEqual(encoded, expected);
    assert.equal(memory.globalMemory[0x200 + encodedLength], 0xa5);

    memory.globalMemory.fill(0x5a, 0x300, 0x380);
    assert.equal(await invoke(0x80, 0xcf, [0x300, 0x200, encodedLength], 2), 0);
    assert.equal(graph.resource.loading.activeProcedures, 1);
    assert.equal(await child.pollProcess(false), 0);
    assert.equal(child.state.stackIndex, 0);
    await graph.codecWorkers.joinPending();
    assert.equal(graph.codecWorkers.hasPendingWork(), false);
    assert.equal(await child.pollProcess(false), 1);
    assert.equal(child.process, null);
    assert.equal(graph.resource.loading.activeProcedures, 0);
    assert.equal(pop32(child.state), plain.length);
    assert.deepEqual(memory.globalMemory.subarray(0x300, 0x300 + plain.length), plain);
    assert.equal(memory.globalMemory[0x300 + plain.length], 0x5a);
    assert.deepEqual(memory.globalMemory.subarray(0x200, 0x200 + encodedLength), expected);
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});

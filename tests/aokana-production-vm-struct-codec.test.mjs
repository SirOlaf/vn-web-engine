import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {decodeAokanaSdcInto} from '../dist/engines/buriko/games/aokana/native/sdc.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM encodes and restores a three-record table through one core scratch owner', async () => {
  const fixture = await createMountedVmFixture();
  const {core, graph, memory, child, definitions, fragments, invoke} = fixture;
  try {
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x80 && [0xc4, 0xc5].includes(secondary))
        .map(({secondary}) => secondary),
      [0xc4, 0xc5],
    );
    assert.equal(fragments.nativeDefinitions().length, definitions.length);
    assert.equal(core.structCodecScratch.pageSize, 4096);
    assert.equal(core.structCodecScratch.reservationActive, true);
    assert.equal(core.structCodecScratch.section.owner, null);
    const plain = new TextEncoder().encode('ABCDEFGHABxyEFGHABxyEFGZ');
    const expectedDcfs = new Uint8Array(40);
    const dcfsHeader = new DataView(expectedDcfs.buffer);
    expectedDcfs.set(new TextEncoder().encode('DCFS FORMAT 1.00'));
    dcfsHeader.setUint32(16, 8, true);
    dcfsHeader.setUint32(20, 3, true);
    expectedDcfs.set(new TextEncoder().encode('ABCDEFGH'), 24);
    expectedDcfs.set([2, 2, 120, 121, 4, 7, 1, 90], 32);
    memory.globalMemory.fill(0xa5, 0x100, 0x180);
    memory.globalMemory.set(plain, 0x110);
    memory.globalMemory.fill(0x5a, 0x200, 0x300);

    assert.equal(await invoke(0x80, 0xc4, [0x200, 0x110, 8, 3], 2), 0);
    assert.equal(graph.resource.loading.activeProcedures, 1);
    assert.equal(await child.pollProcess(false), 0);
    assert.equal(child.state.stackIndex, 0);
    await graph.codecWorkers.joinPending();
    assert.equal(graph.codecWorkers.hasPendingWork(), false);
    assert.equal(await child.pollProcess(false), 1);
    assert.equal(child.process, null);
    assert.equal(graph.resource.loading.activeProcedures, 0);
    const encodedLength = pop32(child.state);
    assert.equal(encodedLength, 73);
    assert.equal(child.state.stackIndex, 0);
    const sdc = memory.globalMemory.subarray(0x200, 0x200 + encodedLength);
    const expectedSdc = new Uint8Array(73);
    const expectedSdcHeader = new DataView(expectedSdc.buffer);
    expectedSdc.set(new TextEncoder().encode('SDC FORMAT 1.00\0'));
    expectedSdcHeader.setUint32(20, 41, true);
    expectedSdcHeader.setUint32(24, 40, true);
    expectedSdcHeader.setUint16(28, 4874, true);
    expectedSdcHeader.setUint16(30, 38, true);
    expectedSdc.set(
      [
        20, 158, 197, 44, 149, 168, 19, 10, 97, 241, 215, 128, 254, 36, 141, 108, 128, 44, 97, 191,
        215, 242, 89, 24, 176, 47, 183, 111, 15, 0, 174, 248, 11, 77, 43, 14, 119, 143, 242, 202,
        54,
      ],
      32,
    );
    assert.deepEqual(sdc, expectedSdc);
    const sdcHeader = new DataView(sdc.buffer, sdc.byteOffset);
    assert.equal(sdcHeader.getUint32(24, true), expectedDcfs.length);
    assert.equal(memory.globalMemory[0x200 + encodedLength], 0x5a);
    const decodedDcfs = new Uint8Array(expectedDcfs.length);
    assert.equal(
      decodeAokanaSdcInto(
        {bytes: decodedDcfs, offset: 0},
        {bytes: memory.globalMemory, offset: 0x200},
      ),
      expectedDcfs.length,
    );
    assert.deepEqual(decodedDcfs, expectedDcfs);

    memory.globalMemory.fill(0x7b, 0x300, 0x340);
    assert.equal(await invoke(0x80, 0xc5, [0x300, 0x200], 0), 1);
    assert.equal(pop32(child.state), 3);
    assert.equal(child.state.stackIndex, 0);
    assert.deepEqual(memory.globalMemory.subarray(0x300, 0x300 + plain.length), plain);
    assert.equal(memory.globalMemory[0x300 + plain.length], 0x7b);
    assert.deepEqual(memory.globalMemory.subarray(0x110, 0x110 + plain.length), plain);
    assert.equal(core.structCodecScratch.section.owner, null);
    assert.equal(graph.resource.loading.activeProcedures, 0);
  } finally {
    await fixture.close();
  }
  assert.equal(core.structCodecScratch.section.owner, null);
  assert.equal(core.structCodecScratch.reservationActive, false);
});

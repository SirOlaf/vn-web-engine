import test from 'node:test';
import assert from 'node:assert/strict';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted 80:0C copies the selected local SYSTEMTIME into BP memory', async () => {
  let reads = 0;
  const readLocalTime = () => {
    reads++;
    return new Date(2026, 8, 25, 14, 34, 56, 789);
  };
  const fixture = await createMountedVmFixture({readLocalTime});
  const {graph, child, definitions, memory, invoke, core} = fixture;
  try {
    assert.equal(graph.readLocalTime, readLocalTime);
    assert.equal(
      definitions.filter(({primary, secondary}) => primary === 0x80 && secondary === 0x0c).length,
      1,
    );
    memory.globalMemory.fill(0xa5, 0x200, 0x220);
    assert.equal(await invoke(0x80, 0x0c, [0x208], 0), 0);
    const output = new DataView(memory.globalMemory.buffer, 0x208, 16);
    assert.deepEqual(
      Array.from({length: 8}, (_, index) => output.getUint16(index * 2, true)),
      [2026, 9, 5, 25, 14, 34, 56, 789],
    );
    assert.deepEqual([...memory.globalMemory.subarray(0x200, 0x208)], Array(8).fill(0xa5));
    assert.deepEqual([...memory.globalMemory.subarray(0x218, 0x220)], Array(8).fill(0xa5));
    assert.equal(reads, 1);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
    assert.equal(core.pendingNativeCallbackCount, 0);
  } finally {
    await fixture.close();
  }
});

test('mounted partial catalog omits 80:0C without a selected local-time source', async () => {
  const fixture = await createMountedVmFixture();
  try {
    assert.equal(fixture.graph.readLocalTime, null);
    assert.equal(
      fixture.definitions.some(({primary, secondary}) => primary === 0x80 && secondary === 0x0c),
      false,
    );
  } finally {
    await fixture.close();
  }
});

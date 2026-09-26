import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted 81:8C–8F retain native-disabled results and preserve BP bytes', async () => {
  const fixture = await createMountedVmFixture();
  const {data, memory, child, definitions, invoke} = fixture;
  const slots = [0x8c, 0x8d, 0x8e, 0x8f];
  try {
    assert.equal(data.memory, memory);
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x81 && slots.includes(secondary))
        .map(({secondary}) => secondary)
        .sort((a, b) => a - b),
      slots,
    );
    assert.deepEqual(
      data
        .nativeDefinitions()
        .filter(({primary, secondary}) => primary === 0x81 && slots.includes(secondary))
        .map(({secondary}) => secondary)
        .sort((a, b) => a - b),
      slots,
    );
    memory.globalMemory.fill(0x5a, 0x180, 0x1c0);
    const before = memory.globalMemory.slice(0x180, 0x1c0);
    for (const secondary of slots) {
      assert.equal(await invoke(0x81, secondary, [0x180, 0x1a0], 0), 1);
      assert.equal(pop32(child.state), 1);
      assert.equal(child.state.stackIndex, 0);
      assert.equal(child.process, null);
      assert.deepEqual(memory.globalMemory.subarray(0x180, 0x1c0), before);
    }
  } finally {
    await fixture.close();
  }
});

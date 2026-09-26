import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM spatial records and queries share one data registry and BP memory', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, data, core, memory, child, definitions, fragments, invoke} = fixture;
  const call = async (secondary, args, expected = 0) => {
    assert.equal(await invoke(0xd0, secondary, args, 0), 1);
    assert.equal(pop32(child.state), expected);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  };
  try {
    assert.equal(data.graph, graph);
    assert.equal(core.data, data);
    assert.equal(core.memory, data.memory);
    assert.equal(core.fragments.data, data);
    assert.equal(data.memory, memory);
    const spatialSlots = [
      0x40, 0x41, 0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x74, 0x75,
      0x78, 0x79, 0x7a,
    ];
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0xd0 && spatialSlots.includes(secondary))
        .map(({secondary}) => secondary)
        .sort((a, b) => a - b),
      spatialSlots,
    );
    assert.equal(
      data
        .nativeDefinitions()
        .filter(({primary, secondary}) => primary === 0xd0 && spatialSlots.includes(secondary))
        .length,
      spatialSlots.length,
    );
    assert.equal(fragments.nativeDefinitions().length, definitions.length);

    const view = new DataView(memory.globalMemory.buffer);
    view.setUint32(0x100, 0xffffffff, true);
    await call(0x40, [0x100]);
    const id = view.getUint32(0x100, true);
    assert.equal(id, 1);
    const values = [0, 0, 0, 65536, 0, 0, 131072, 196608, 262144];
    for (const index of [0, 1, 2]) await call(0x60, [id, index, ...values, 1, 7]);
    await call(0x64, [id, 1, 65536, 0, 0]);
    await call(0x64, [id, 2, 10 * 65536, 0, 0]);
    view.setUint32(0x20c, 0x12345678, true);
    await call(0x65, [0x200, id, 1]);
    assert.deepEqual(
      [view.getInt32(0x200, true), view.getInt32(0x204, true), view.getInt32(0x208, true)],
      [65536, 0, 0],
    );
    assert.equal(view.getUint32(0x20c, true), 0x12345678);

    await call(0x68, [id, 1, 0, 0]);
    await call(0x68, [id, 2, 0, 0]);
    view.setUint32(0x220, 0xffffffff, true);
    await call(0x69, [0x220, id, 1, 0]);
    assert.equal(view.getUint32(0x220, true), 0);
    view.setUint32(0x230, 0xaaaaaaaa, true);
    view.setUint32(0x234, 0xcccccccc, true);
    view.setUint32(0x240, 0xbbbbbbbb, true);
    await call(0x6a, [0x230, 0x240, id, 0, 0]);
    assert.equal(view.getUint32(0x230, true), 1);
    assert.equal(view.getUint32(0x234, true), 2);
    assert.equal(view.getUint32(0x240, true), 2);

    view.setUint32(0x250, 0xffffffff, true);
    view.setUint32(0x260, 0xffffffff, true);
    await call(0x75, [0x260, 0x250, id, 0, 0, 0, 65536, 0, 1]);
    assert.equal(view.getUint32(0x250, true), 1);
    assert.equal(view.getUint32(0x260, true), 1);
    view.setUint32(0x250, 0xaaaaaaaa, true);
    view.setUint32(0x260, 0xbbbbbbbb, true);
    view.setUint32(0x264, 0xcccccccc, true);
    await call(0x75, [0x260, 0x250, id, 0, 0, 0, 65536, -1, 1]);
    assert.equal(view.getUint32(0x250, true), 2);
    assert.deepEqual([view.getUint32(0x260, true), view.getUint32(0x264, true)], [0, 1]);

    await call(0x61, [id, 2]);
    await call(0x61, [id, 1]);
    await call(0x61, [id, 0]);
    await call(0x41, [id]);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});

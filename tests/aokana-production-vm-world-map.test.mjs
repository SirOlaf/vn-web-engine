import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM world maps share the data owner and BP memory', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, data, core, memory, child, definitions, invoke} = fixture;
  const view = new DataView(memory.globalMemory.buffer);
  const call = async (secondary, args) => {
    assert.equal(await invoke(0xd0, secondary, args, 0), 1);
    assert.equal(pop32(child.state), 0);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  };
  const path = async (id, expected) => {
    view.setUint32(0x300, 0xaaaaaaaa, true);
    view.setUint32(0x310, 0xbbbbbbbb, true);
    view.setUint32(0x314, 0xcccccccc, true);
    await call(0xc8, [0x300, 0x310, id, 0, 3, -1]);
    assert.equal(view.getUint32(0x300, true), 2);
    assert.deepEqual([view.getUint32(0x310, true), view.getUint32(0x314, true)], expected);
  };
  try {
    assert.equal(data.graph, graph);
    assert.equal(core.data, data);
    assert.equal(core.memory, data.memory);
    assert.equal(data.memory, memory);
    const slots = [0xc0, 0xc1, 0xc2, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8];
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0xd0 && slots.includes(secondary))
        .map(({secondary}) => secondary)
        .sort((a, b) => a - b),
      slots,
    );

    view.setUint32(0x100, 0xffffffff, true);
    await call(0xc0, [0x100, 4, 2]);
    const id = view.getUint32(0x100, true);
    assert.equal(id, 1);
    const points = [
      [0, 0],
      [1, 1],
      [1, -1],
      [2, 0],
    ];
    for (let index = 0; index < points.length; index++) {
      const offset = 0x200 + index * 16;
      const point = points[index];
      view.setInt32(offset, point[0] * 65536, true);
      view.setInt32(offset + 4, point[1] * 65536, true);
      view.setInt32(offset + 8, 0, true);
      view.setInt32(offset + 12, 0, true);
      await call(0xc4, [id, index, offset]);
    }
    for (const [source, destination] of [
      [0, 2],
      [0, 1],
      [2, 3],
      [1, 3],
    ]) {
      await call(0xc6, [id, source, destination, 65536, 0, 0]);
    }
    await path(id, [1, 3]);
    await call(0xc4, [id, 1, 0x210]);
    await path(id, [2, 3]);

    await call(0xc7, [id, 0, 1]);
    await call(0xc5, [id, 1]);
    await call(0xc2, [id]);
    await call(0xc1, [id]);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});

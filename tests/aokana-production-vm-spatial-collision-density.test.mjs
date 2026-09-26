import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

const q16 = (value) => value * 65536;

test('mounted spatial collision and density share the data registry and BP memory', async () => {
  const fixture = await createMountedVmFixture();
  const {data, core, memory, child, definitions, invoke} = fixture;
  const view = new DataView(memory.globalMemory.buffer);
  const call = async (secondary, args, expected = 0) => {
    assert.equal(await invoke(0xd0, secondary, args, 0), 1);
    assert.equal(pop32(child.state), expected);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  };
  try {
    assert.equal(core.data, data);
    assert.equal(core.memory, data.memory);
    assert.equal(data.memory, memory);
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) => primary === 0xd0 && [0x70, 0x71, 0x7b].includes(secondary),
        )
        .map(({secondary}) => secondary),
      [0x70, 0x71, 0x7b],
    );

    view.setUint32(0x100, 0xffffffff, true);
    await call(0x40, [0x100]);
    const id = view.getUint32(0x100, true);
    assert.equal(id, 1);
    const values = (point) => [...point, 0, 0, 0, 1, 0, 0].map(q16);
    await call(0x60, [id, 0, ...values([10, 20, 30]), 1, 0]);
    await call(0x60, [id, 1, ...values([13, 24, 30]), 1, 0]);

    // With a null count pointer, the native collector exits before incrementing hits.
    await call(0x70, [id, 0, q16(13), q16(24), q16(30), 1, 0]);
    view.setUint32(0x2f0, 0xaaaaaaaa, true);
    view.setUint32(0x300, 0xbbbbbbbb, true);
    await call(0x71, [0x300, 0x2f0, id, 0, q16(13), q16(24), q16(30), 1, 0]);
    assert.equal(view.getUint32(0x2f0, true), 1);
    assert.equal(view.getUint32(0x300, true), 1);
    view.setUint32(0x2f0, 0xaaaaaaaa, true);
    view.setUint32(0x300, 0xbbbbbbbb, true);
    await call(0x71, [0x300, 0x2f0, id, 1, q16(10), q16(20), q16(30), 1, 0]);
    assert.equal(view.getUint32(0x2f0, true), 1);
    assert.equal(view.getUint32(0x300, true), 0);

    await call(0x61, [id, 1]);
    await call(0x61, [id, 0]);
    await call(0x60, [id, 2, ...values([2, 2, 0]), 1, 0]);
    await call(0x62, [id, 2, 5, q16(10)]);
    await call(0x62, [id, 2, 6, q16(1)]);
    for (let offset = 0; offset < 16; offset += 4) view.setUint32(0x320 + offset, 0xcccccccc, true);
    await call(0x7b, [0x320, id, 0, 0, 0, 10, 4, 4, 0, 1, 0, -1, 1]);
    assert.deepEqual(
      [0, 4, 8, 12].map((offset) => view.getInt32(0x320 + offset, true)),
      [q16(5), q16(5), 0, 0],
    );

    await call(0x61, [id, 2]);
    await call(0x41, [id]);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});

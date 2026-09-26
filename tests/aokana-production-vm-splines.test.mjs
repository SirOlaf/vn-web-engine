import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted C0 spline callbacks use one BP data registry', async () => {
  const fixture = await createMountedVmFixture();
  const {data, core, memory, child, definitions, invoke} = fixture;
  const view = new DataView(memory.globalMemory.buffer);
  const call = async (secondary, args, expected = 0) => {
    assert.equal(await invoke(0xc0, secondary, args, 0), 1);
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
          ({primary, secondary}) => primary === 0xc0 && secondary >= 0xc0 && secondary <= 0xc3,
        )
        .map(({secondary}) => secondary),
      [0xc0, 0xc1, 0xc2, 0xc3],
    );

    assert.equal(await invoke(0xc0, 0xc0, [], 0), 1);
    const id = pop32(child.state);
    assert.equal(id, 0x80000001);
    assert.equal(child.state.stackIndex, 0);
    const points = [0, 0, 0, 0x11111111, 100, -100, 50, 0x22222222];
    points.forEach((value, index) => view.setInt32(0x200 + index * 4, value, true));
    await call(0xc2, [id, 2, 0x200, 10]);

    for (let offset = 0; offset < 16; offset += 4) view.setUint32(0x300 + offset, 0xaaaaaaaa, true);
    await call(0xc3, [0x300, id, 5]);
    assert.deepEqual(
      [0, 4, 8].map((offset) => view.getInt32(0x300 + offset, true)),
      [50, -50, 25],
    );
    assert.equal(view.getUint32(0x30c, true), 0xaaaaaaaa);
    assert.deepEqual(
      [0, 1, 2, 3, 4, 5, 6, 7].map((index) => view.getInt32(0x200 + index * 4, true)),
      points,
    );
    await call(0xc1, [id]);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});

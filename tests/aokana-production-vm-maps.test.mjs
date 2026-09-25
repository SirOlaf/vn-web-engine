import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted map callbacks copy BP cells and scroll graph-owned tile surfaces', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, memory, child, definitions, invoke} = fixture;
  const call = async (secondary, args, pushed = 0) => {
    assert.equal(await invoke(0x90, secondary, args, 0), pushed);
    assert.equal(child.process, null);
  };
  const bounds = {left: 0, top: 0, right: 3, bottom: 0};
  try {
    assert.equal(graph.maps.manager, graph.manager);
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) =>
            primary === 0x90 &&
            [0x70, 0x71, 0x74, 0x75, 0x76, 0x78, 0x79, 0x7a].includes(secondary),
        )
        .map(({secondary}) => secondary),
      [0x70, 0x71, 0x74, 0x75, 0x76, 0x78, 0x79, 0x7a],
    );
    await call(0x11, [3, 6, 1, 0]);
    await call(0x11, [4, 4, 1, 0]);
    const tiles = graph.surfaces.descriptor(3);
    const tilePixels = [0x0011, 0x0012, 0x0021, 0x0022, 0x0031, 0x0032];
    tilePixels.forEach((pixel, index) => tiles.storage.view.setUint16(index * 2, pixel, true));
    tiles.storage.written(0, 12);
    const source = new DataView(memory.globalMemory.buffer);
    [0, 1, 2, 2, 1, 0].forEach((cell, index) => source.setUint16(0x400 + index * 2, cell, true));

    await call(0x70, [], 1);
    const handle = pop32(child.state);
    assert.equal(handle, 0xa0000000);
    const map = graph.manager.find('map', handle);
    assert.ok(map);
    assert.equal(map.surfaces, graph.surfaces);
    assert.equal(graph.manager.categoryCount(3), 1);
    await call(0x76, [handle, 2, 1, 2, 1]);
    await call(0x75, [handle, 0, 0, 3, 0x80, 0, 2]);
    await call(0x78, [handle, 3, 2, 0x400]);
    source.setUint16(0x400, 2, true);
    await call(0x74, [handle, 1]);
    const output = graph.surfaces.snapshot(4);
    assert.ok(output);
    const draw = () => {
      map.draw(output, bounds, 0);
      return Array.from({length: 4}, (_, index) =>
        output.storage.view.getUint16(output.offset + index * 2, true),
      );
    };
    await call(0x79, [handle, 0, 0, 1, 0, 1]);
    assert.deepEqual(draw(), [0x0012, 0x0021, 0x0022, 0x0031]);
    await call(0x79, [handle, 2, 0, 1, 0, 1]);
    assert.deepEqual(draw(), [0x0032, 0x0011, 0x0012, 0x0021]);
    await call(0x7a, [handle, 7]);
    assert.deepEqual(draw(), [0x0032, 0x0011, 0x0012, 0x0021]);
    await call(0x71, [handle]);
    assert.equal(graph.manager.find('map', handle), null);
    assert.equal(graph.manager.categoryCount(3), 0);
    for (const index of [4, 3]) {
      await call(0x12, [index], 1);
      assert.equal(pop32(child.state), 1);
    }
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});

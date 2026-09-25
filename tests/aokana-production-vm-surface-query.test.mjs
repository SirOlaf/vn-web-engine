import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

function pixels(bitmap) {
  return Array.from({length: bitmap.width * bitmap.height}, (_, index) =>
    bitmap.storage.view.getUint32(
      bitmap.offset + Math.floor(index / bitmap.width) * bitmap.stride + (index % bitmap.width) * 4,
      true,
    ),
  );
}

test('mounted VM queries pixels, configures coefficients, and destroys graph objects by category', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, memory, child, definitions, invoke} = fixture;
  try {
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) =>
            primary === 0x92 && [0x00, 0x01, 0x12, 0x13, 0x16, 0x17, 0x31].includes(secondary),
        )
        .map(({secondary}) => secondary),
      [0x00, 0x01, 0x12, 0x13, 0x16, 0x17, 0x31],
    );
    assert.equal(graph.manager.surfaces, graph.surfaces);
    assert.equal(graph.surfaces.coefficientTables.capacity, 8);
    const memoryView = new DataView(memory.globalMemory.buffer);
    for (const [index, pixel] of [0x40224466, 0x80224466, 0xc0112233].entries())
      memoryView.setUint32(0x280 + index * 4, pixel, true);
    assert.equal(await invoke(0x90, 0x14, [2, 3, 1, 2, 0x280], 0), 0);
    assert.deepEqual(pixels(graph.surfaces.snapshot(2)), [0x40224466, 0x80224466, 0xc0112233]);

    assert.equal(await invoke(0x92, 0x12, [2, -3, 19], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(await invoke(0x92, 0x16, [0x220, 2], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.deepEqual(
      [memoryView.getInt32(0x220, true), memoryView.getInt32(0x224, true)],
      [-3, 19],
    );
    assert.equal(await invoke(0x92, 0x13, [2, 0x00224466, 0xeeaabbcc], 0), 1);
    assert.equal(pop32(child.state), 0);
    assert.deepEqual(pixels(graph.surfaces.snapshot(2)), [0x40aabbcc, 0x80aabbcc, 0xc0112233]);
    for (const [x, expected] of [
      [0, 0x40aabbcc],
      [1, 0x80aabbcc],
      [2, 0xc0112233],
    ]) {
      assert.equal(await invoke(0x92, 0x17, [0x230, 2, x, 0], 0), 1);
      assert.equal(pop32(child.state), 0);
      assert.equal(memoryView.getUint32(0x230, true), expected);
      assert.equal(child.state.stackIndex, 0);
    }

    assert.equal(await invoke(0x92, 0x00, [0, 1, 256, 2, 2], 0), 0);
    assert.equal(await invoke(0x92, 0x01, [1, 1, 256, 1, 1, 2, 1], 0), 0);
    assert.deepEqual(
      [
        graph.surfaces.coefficientTables.snapshot(0).span,
        graph.surfaces.coefficientTables.snapshot(1).span,
      ],
      [8, 24],
    );
    assert.equal(graph.surfaces.coefficientTables.snapshot(0).active, 1);
    assert.equal(graph.surfaces.coefficientTables.snapshot(1).active, 1);
    assert.ok(
      graph.surfaces.coefficientTables.snapshot(0).coefficients.some((value) => value !== 0),
    );
    assert.ok(
      graph.surfaces.coefficientTables.snapshot(1).coefficients.some((value) => value !== 0),
    );

    assert.equal(await invoke(0x90, 0x50, [], 0), 1);
    const spriteHandle = pop32(child.state);
    assert.equal(await invoke(0x90, 0x56, [spriteHandle, 4, 5, 2, 0x80, 12, 7], 0), 0);
    assert.equal(await invoke(0x90, 0x54, [spriteHandle, 1], 0), 0);
    assert.ok(graph.manager.find('sprite', spriteHandle));
    graph.damage.clear();
    assert.equal(await invoke(0x92, 0x31, [spriteHandle], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(graph.manager.find('sprite', spriteHandle), null);
    assert.ok(graph.damage.snapshot().length > 0);

    assert.equal(await invoke(0x90, 0xe0, [], 0), 1);
    const groupHandle = pop32(child.state);
    assert.ok(graph.manager.find('group', groupHandle));
    assert.equal(graph.manager.categoryCount(0x11), 1);
    assert.equal(await invoke(0x92, 0x31, [groupHandle], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(graph.manager.find('group', groupHandle), null);
    assert.equal(graph.manager.categoryCount(0x11), 0);

    graph.surfaces.coefficientTables.clear();
    assert.equal(graph.surfaces.coefficientTables.snapshot(0).active, 0);
    assert.equal(graph.surfaces.coefficientTables.snapshot(1).active, 0);
    assert.equal(await invoke(0x90, 0x12, [2], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});

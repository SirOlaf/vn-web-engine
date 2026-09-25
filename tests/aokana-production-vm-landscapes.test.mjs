import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaDisplayLandscape} from '../dist/engines/buriko/games/aokana/native/display-landscape.js';
import {clearAokanaBitmap} from '../dist/engines/buriko/games/aokana/native/bitmap-copy.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted Landscape callbacks own terrain, cells, overlays, and surface readback', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, memory, child, definitions, invoke} = fixture;
  const call = async (primary, secondary, args, pushed = 0) => {
    assert.equal(await invoke(primary, secondary, args, 0), pushed);
    assert.equal(child.process, null);
  };
  const put = (address, values) =>
    values.forEach((value, index) => bp.setUint32(address + index * 4, value, true));
  const bp = new DataView(memory.globalMemory.buffer);
  const red = 0xff0000e0;
  const blue = 0xffd00000;
  const bounds = {left: 0, top: 0, right: 11, bottom: 9};
  try {
    assert.equal(graph.landscapes.manager, graph.manager);
    assert.equal(graph.landscapes.input, graph.input);
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) => primary === 0x91 && secondary >= 0x70 && secondary <= 0x7f,
        )
        .map(({secondary}) => secondary),
      [0x70, 0x71, 0x73, 0x74, 0x75, 0x76, 0x78, 0x79, 0x7a, 0x7b, 0x7c, 0x7d, 0x7e, 0x7f],
    );
    await call(0x90, 0x11, [3, 8, 4, 2]);
    await call(0x90, 0x11, [4, 12, 10, 2]);
    const atlas = graph.surfaces.descriptor(3);
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 8; x++)
        atlas.storage.view.setUint32((y * 8 + x) * 4, x < 4 ? red : blue, true);
    atlas.storage.written(0, 128);
    put(0x100, [0, 0, 4, 4, 0, 4, 0, 4, 4, 0]);
    put(0x200, [1, 0]);
    bp.setUint32(0x200 + 33 * 4, 1, true);
    put(0x288, [2, 0, 1]);
    bp.setUint32(0x288 + 33 * 4, 1, true);
    put(0x400, [0, 1, 1, 0]);

    await call(0x91, 0x70, [4, 2, 2, 6, 1, 1], 1);
    const handle = pop32(child.state);
    assert.equal(handle, 0xa1000000);
    const landscape = graph.manager.find('landscape', handle);
    assert.ok(landscape instanceof AokanaDisplayLandscape);
    assert.equal(landscape.surfaces, graph.surfaces);
    assert.equal(graph.manager.categoryCount(4), 1);
    await call(0x91, 0x75, [handle, 0, 0, 0x80, 0, 2]);
    await call(0x91, 0x78, [handle, 3, 2, 0x100, 1, 2, 0x200]);
    await call(0x91, 0x79, [handle, 2, 2, 0x400]);
    bp.setUint32(0x400, 1, true); // The graph owns a copy of the BP cell record.
    await call(0x91, 0x74, [handle, 1]);
    const keys = new Uint32Array(landscape.copyExpandedSortKeys(null));
    landscape.copyExpandedSortKeys(keys);
    assert.deepEqual([...keys], [0x22000, 0x32000, 0x32020, 0x42020]);
    const output = graph.surfaces.snapshot(4);
    const pixel = (x, y) => output.storage.view.getUint32((y * 12 + x) * 4, true);
    const draw = (key) => {
      clearAokanaBitmap(output);
      landscape.draw(output, bounds, key);
    };
    draw(0x22000);
    assert.equal(pixel(1, 3), red);
    draw(0x32000);
    assert.equal(pixel(5, 1), blue);
    assert.equal(pixel(5, 5), red);
    await call(0x91, 0x7e, [0x500, handle, 0, 1], 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(bp.getUint32(0x500, true), 3);
    await call(0x91, 0x7f, [5, handle, 0, 1], 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(graph.surfaces.descriptor(5).storage.view.getUint32(0, true), red);

    graph.input.pointerAvailable = true;
    graph.input.touchPositions = [[5, 1]];
    await call(0x91, 0x73, [0x504, handle, 0], 1);
    assert.equal(pop32(child.state), 1);
    assert.deepEqual([bp.getUint32(0x504, true), bp.getUint32(0x508, true)], [1, 0]);
    put(0x504, [77, 88]);
    await call(0x91, 0x73, [0x504, handle, 1], 1);
    assert.equal(pop32(child.state), 0);
    assert.deepEqual([bp.getUint32(0x504, true), bp.getUint32(0x508, true)], [77, 88]);
    await call(0x91, 0x76, [handle, 0, 0, 1, 256, 0x00a0b0c0]);
    draw(0x22000);
    assert.equal(pixel(1, 3), 0xffa0b0c0);
    await call(0x91, 0x76, [handle, 0, 0, 0, 0, 0]);
    put(0x520, [0, 0, 2, 2, 0]);
    await call(0x91, 0x7a, [handle, 3, 1, 0x520]);
    put(0x540, [1, 0]);
    await call(0x91, 0x7b, [handle, 1, 0x540, 0, 0, 0]);
    draw(0x32000);
    assert.equal(pixel(5, 2), red);
    await call(0x91, 0x7b, [handle, 1, 0x540, 0, 0xffffffff, 0]);
    await call(0x91, 0x7c, [handle, 0, 1]);
    draw(0x22000);
    assert.equal(pixel(1, 3), blue);
    await call(0x90, 0x12, [5], 1);
    assert.equal(pop32(child.state), 1);
    await call(0x91, 0x7f, [5, handle, 0, 0], 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(graph.surfaces.descriptor(5).storage.view.getUint32(0, true), blue);
    await call(0x91, 0x7d, [handle, 1, 1, 1]);
    await call(0x91, 0x7e, [0x500, handle, 1, 1], 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(bp.getUint32(0x500, true), 4);
    await call(0x91, 0x71, [handle]);
    assert.equal(graph.manager.find('landscape', handle), null);
    assert.equal(graph.manager.categoryCount(4), 0);
    for (const id of [5, 4, 3]) {
      await call(0x90, 0x12, [id], 1);
      assert.equal(pop32(child.state), 1);
    }
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});

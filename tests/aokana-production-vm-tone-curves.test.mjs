import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

const pixels = (bitmap) =>
  Array.from({length: bitmap.width * bitmap.height}, (_, index) =>
    bitmap.storage.view.getUint32(
      bitmap.offset + Math.floor(index / bitmap.width) * bitmap.stride + (index % bitmap.width) * 4,
      true,
    ),
  );

test('mounted VM tone curves copy BP control points and transform RGB/RGBA surfaces', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, memory, child, definitions, fragments, invoke} = fixture;
  try {
    assert.equal(graph.surfaces.fonts, graph.fonts);
    assert.equal(graph.surfaces.compositor, graph.compositor);
    assert.equal(graph.surfaces.allocator, graph.allocator);
    assert.equal(graph.fonts.text, graph.text);
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x90 && [0xcc, 0xcd].includes(secondary))
        .map(({secondary}) => secondary),
      [0xcc, 0xcd],
    );
    assert.equal(fragments.nativeDefinitions().length, definitions.length);
    const view = new DataView(memory.globalMemory.buffer);
    [63, 96, 127, 160, 191, 224].forEach((value, index) =>
      view.setUint32(0x100 + index * 4, value, true),
    );
    assert.equal(await invoke(0x90, 0xcc, [17, 0x100], 0), 0);
    assert.ok(graph.surfaces.toneCurves.find(17));
    memory.globalMemory.set([255, 255, 255, 0, 0, 0, 255, 255, 255], 0x180);
    assert.equal(await invoke(0x90, 0x14, [0, 3, 1, 1, 0x180], 0), 0);
    [0xffffffff, 0x80000000, 0x40ffffff].forEach((pixel, index) =>
      view.setUint32(0x1c0 + index * 4, pixel, true),
    );
    assert.equal(await invoke(0x90, 0x14, [1, 3, 1, 2, 0x1c0], 0), 0);
    assert.deepEqual(pixels(graph.surfaces.snapshot(0)), [0xffffff, 0, 0xffffff]);
    assert.deepEqual(pixels(graph.surfaces.snapshot(1)), [0xffffffff, 0x80000000, 0x40ffffff]);
    const effect = (destination, source, filmMode = 8) => [
      destination,
      source,
      0x4080c0,
      256,
      17,
      0x204080,
      filmMode,
      256,
    ];
    assert.equal(await invoke(0x90, 0xcd, effect(2, 0), 0), 0);
    assert.equal(await invoke(0x90, 0xcd, effect(3, 1, 38), 0), 0);
    assert.deepEqual(pixels(graph.surfaces.snapshot(2)), [0x1872e1, 0, 0x1872e1]);
    assert.deepEqual(pixels(graph.surfaces.snapshot(3)), [0xff1872e1, 0x80000000, 0x401872e1]);
    // The live key holds copied points; changing the BP table does not change it yet.
    for (const offset of [0x104, 0x10c, 0x114]) view.setUint32(offset, 128, true);
    assert.equal(await invoke(0x90, 0xcd, effect(5, 1), 0), 0);
    assert.deepEqual(pixels(graph.surfaces.snapshot(5)), [0xff1872e1, 0x80000000, 0x401872e1]);
    assert.equal(await invoke(0x90, 0xcc, [17, 0x100], 0), 0);
    assert.equal(await invoke(0x90, 0xcd, effect(4, 1), 0), 0);
    assert.deepEqual(pixels(graph.surfaces.snapshot(4)), [0xff224281, 0x80000000, 0x40224281]);
    memory.globalMemory.fill(0xa5, 0x300, 0x340);
    assert.equal(await invoke(0x90, 0x15, [0x300, 0x280, 64, 4], 0), 0);
    assert.equal(view.getUint32(0x280, true), 12);
    assert.deepEqual(
      memory.globalMemory.subarray(0x300, 0x30c),
      Uint8Array.from([129, 66, 34, 255, 0, 0, 0, 128, 129, 66, 34, 64]),
    );
    assert.equal(memory.globalMemory[0x30c], 0xa5);
    assert.equal(await invoke(0x90, 0xcc, [17, 0], 0), 0);
    assert.equal(graph.surfaces.toneCurves.find(17), null);
    assert.equal(child.state.stackIndex, 0);
    for (const index of [5, 4, 3, 2, 1, 0]) {
      assert.equal(await invoke(0x90, 0x12, [index], 0), 1);
      assert.equal(pop32(child.state), 1);
    }
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});

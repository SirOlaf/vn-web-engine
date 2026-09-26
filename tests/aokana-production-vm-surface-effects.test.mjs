import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {bitmapRead32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

const gray = (value) => value * 0x010101;
const pixels = (bitmap) =>
  Array.from({length: bitmap.width * bitmap.height}, (_, index) =>
    bitmapRead32(
      bitmap,
      bitmap.offset + Math.floor(index / bitmap.width) * bitmap.stride + (index % bitmap.width) * 4,
    ),
  );

test('mounted VM surface effects transition, vector-map, and blur shared graph pixels', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, memory, child, definitions, fragments, invoke} = fixture;
  const call = async (secondary, args) => {
    assert.equal(await invoke(0x90, secondary, args, 0), 0);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  };
  try {
    assert.equal(graph.surfaceEffects.surfaces, graph.surfaces);
    assert.equal(graph.surfaces.compositor, graph.compositor);
    assert.equal(graph.surfaces.fonts, graph.fonts);
    assert.equal(graph.resource.errors.files.text, graph.text);
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) => primary === 0x90 && [0x19, 0x1a, 0x1b].includes(secondary),
        )
        .map(({secondary}) => secondary),
      [0x19, 0x1a, 0x1b],
    );
    assert.equal(fragments.nativeDefinitions().length, definitions.length);

    // Format-one import consumes packed BGR24; all channels are equal in this profile.
    memory.globalMemory.fill(160, 0x200, 0x218);
    memory.globalMemory.set([0, 64, 128, 255, 0, 64, 128, 255], 0x240);
    await call(0x11, [1, 4, 2, 1]);
    await call(0x13, [1, gray(32)]);
    await call(0x14, [2, 4, 2, 1, 0x200]);
    await call(0x14, [3, 4, 2, 3, 0x240]);
    await call(0x19, [1, 0, 0, 2, 3, 0, 128]);
    assert.deepEqual(pixels(graph.surfaces.snapshot(1)), [
      gray(32),
      gray(64),
      gray(96),
      gray(159),
      gray(32),
      gray(64),
      gray(96),
      gray(159),
    ]);
    assert.deepEqual(
      [...graph.surfaces.snapshot(3).storage.bytes.subarray(0, 8)],
      [0, 64, 128, 255, 0, 64, 128, 255],
    );

    await call(0x11, [4, 4, 2, 1]);
    await call(0x13, [4, gray(32)]);
    await call(0x19, [4, 1, 0, 2, -1, 0, 128]);
    assert.deepEqual(pixels(graph.surfaces.snapshot(4)), [
      gray(32),
      gray(96),
      gray(96),
      gray(96),
      gray(32),
      gray(96),
      gray(96),
      gray(96),
    ]);

    memory.globalMemory.set(
      Uint8Array.from({length: 18}, (_, index) => (index < 9 ? 64 : 128)),
      0x280,
    );
    const vectorBytes = new DataView(memory.globalMemory.buffer);
    for (let index = 0; index < 6; index++)
      vectorBytes.setUint32(0x2c0 + index * 4, 0x00100000, true);
    await call(0x11, [5, 3, 2, 1]);
    await call(0x13, [5, gray(32)]);
    await call(0x14, [6, 3, 2, 1, 0x280]);
    await call(0x14, [7, 3, 2, 4, 0x2c0]);
    await call(0x1a, [5, 6, 7, -1, 256, 0]);
    assert.deepEqual(pixels(graph.surfaces.snapshot(5)), [
      gray(128),
      gray(128),
      gray(128),
      0,
      0,
      0,
    ]);

    await call(0x11, [8, 3, 2, 1]);
    await call(0x13, [8, 0]);
    await call(0x1b, [8, 6, 1, 1]);
    assert.deepEqual(pixels(graph.surfaces.snapshot(8)), [
      gray(64),
      gray(64),
      gray(64),
      gray(128),
      gray(128),
      gray(128),
    ]);
    for (const index of [8, 7, 6, 5, 4, 3, 2, 1]) {
      assert.equal(await invoke(0x90, 0x12, [index], 0), 1);
      assert.equal(pop32(child.state), 1);
      assert.equal(child.state.stackIndex, 0);
    }
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {bitmapRead32} from '../dist/engines/buriko/native/bitmap-scalar.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

const gray = (value) => value * 0x010101;
const pixels = (bitmap) =>
  Array.from({length: bitmap.width * bitmap.height}, (_, index) =>
    bitmapRead32(
      bitmap,
      bitmap.offset + Math.floor(index / bitmap.width) * bitmap.stride + (index % bitmap.width) * 4,
    ),
  );

test('mounted VM surface splat accumulates into graph pixels and exports exact BGR bytes', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, memory, child, definitions, fragments, invoke} = fixture;
  try {
    assert.equal(graph.surfaces.fonts, graph.fonts);
    assert.equal(graph.surfaces.compositor, graph.compositor);
    assert.equal(graph.surfaces.allocator, graph.allocator);
    assert.equal(graph.resource.errors.files.text, graph.text);
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x91 && secondary === 0x1b)
        .map(({secondary}) => secondary),
      [0x1b],
    );
    assert.equal(fragments.nativeDefinitions().length, definitions.length);

    for (const [index, color] of [
      [0, gray(32)],
      [1, gray(128)],
    ]) {
      assert.equal(await invoke(0x90, 0x11, [index, 4, 4, 1], 0), 0);
      assert.equal(await invoke(0x90, 0x13, [index, color], 0), 0);
    }
    assert.deepEqual(pixels(graph.surfaces.snapshot(0)), Array(16).fill(gray(32)));
    assert.deepEqual(pixels(graph.surfaces.snapshot(1)), Array(16).fill(gray(128)));
    assert.equal(await invoke(0x91, 0x1b, [1, 0, 32768, 32768, 128], 0), 0);
    const levels = [4, 16, 12, 0, 16, 64, 48, 0, 12, 48, 36, 0, 0, 0, 0, 0];
    assert.deepEqual(pixels(graph.surfaces.snapshot(1)), levels.map(gray));
    assert.deepEqual(pixels(graph.surfaces.snapshot(0)), Array(16).fill(gray(32)));
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);

    memory.globalMemory.fill(0xa5, 0x400, 0x440);
    assert.equal(await invoke(0x90, 0x15, [0x400, 0x300, 64, 1], 0), 0);
    const view = new DataView(memory.globalMemory.buffer);
    assert.equal(view.getUint32(0x300, true), 48);
    assert.deepEqual(
      [...memory.globalMemory.subarray(0x400, 0x430)],
      levels.flatMap((value) => [value, value, value]),
    );
    assert.equal(memory.globalMemory[0x430], 0xa5);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);

    for (const index of [1, 0]) {
      assert.equal(await invoke(0x90, 0x12, [index], 0), 1);
      assert.equal(pop32(child.state), 1);
    }
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});

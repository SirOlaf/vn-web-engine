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
const maskBytes = (bitmap) =>
  Array.from(
    {length: bitmap.width * bitmap.height},
    (_, index) =>
      bitmap.storage.bytes[
        bitmap.offset + Math.floor(index / bitmap.width) * bitmap.stride + (index % bitmap.width)
      ],
  );

test('mounted VM luminance masks feed recolor, effect, mask, and duplicate surface callbacks', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, memory, child, definitions, invoke} = fixture;
  try {
    assert.equal(graph.surfaces.fonts, graph.fonts);
    assert.equal(graph.surfaces.compositor, graph.compositor);
    assert.equal(graph.surfaces.allocator, graph.allocator);
    assert.equal(graph.fonts.text, graph.text);
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) =>
            (primary === 0x91 && [0x1a, 0x1d, 0x1e, 0x1f].includes(secondary)) ||
            (primary === 0x92 && [0x18, 0x19].includes(secondary)),
        )
        .map(({primary, secondary}) => [primary, secondary]),
      [
        [0x91, 0x1a],
        [0x91, 0x1d],
        [0x91, 0x1e],
        [0x91, 0x1f],
        [0x92, 0x18],
        [0x92, 0x19],
      ],
    );
    const view = new DataView(memory.globalMemory.buffer);
    const colorSource = [0xc0abcdef, 0x80abcdef, 0xffabcdef, 0x40abcdef];
    colorSource.forEach((pixel, index) => view.setUint32(0x200 + index * 4, pixel, true));
    assert.equal(await invoke(0x90, 0x14, [0, 4, 1, 2, 0x200], 0), 0);
    for (const index of [1, 2]) assert.equal(await invoke(0x90, 0x11, [index, 4, 1, 2], 0), 0);
    assert.equal(await invoke(0x91, 0x1a, [1, 0, 0x203040], 0), 0);
    assert.deepEqual(
      pixels(graph.surfaces.snapshot(1)),
      [0xc0203040, 0x80203040, 0xff203040, 0x40203040],
    );
    assert.equal(await invoke(0x91, 0x1d, [2, 1, 4, 0x202020, 128], 0), 0);
    assert.deepEqual(
      pixels(graph.surfaces.snapshot(2)),
      [0xc0304050, 0x80304050, 0xff304050, 0x40304050],
    );

    memory.globalMemory.set([255, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0], 0x240);
    assert.equal(await invoke(0x90, 0x14, [4, 4, 1, 1, 0x240], 0), 0);
    assert.equal(await invoke(0x92, 0x18, [5, 4], 0), 0);
    assert.deepEqual(maskBytes(graph.surfaces.snapshot(5)), [255, 76, 150, 27]);
    assert.equal(graph.surfaces.snapshot(5).format, 3);
    assert.equal(await invoke(0x92, 0x19, [5], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.deepEqual(maskBytes(graph.surfaces.snapshot(5)), [0, 179, 105, 228]);
    view.setUint32(0x260, 0x80ffffff, true);
    view.setUint32(0x264, 0xffff0000, true);
    assert.equal(await invoke(0x90, 0x14, [6, 2, 1, 2, 0x260], 0), 0);
    assert.equal(await invoke(0x92, 0x18, [7, 6], 0), 0);
    assert.deepEqual(maskBytes(graph.surfaces.snapshot(7)), [127, 76]);
    assert.equal(graph.surfaces.snapshot(7).format, 3);

    assert.equal(await invoke(0x91, 0x1e, [2, 5, 0, 0], 0), 0);
    const expected = [0x00304050, 0x59304050, 0x68304050, 0x39304050];
    assert.deepEqual(pixels(graph.surfaces.snapshot(2)), expected);
    assert.equal(await invoke(0x92, 0x12, [2, 13, -4], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(await invoke(0x91, 0x1f, [3, 2], 0), 0);
    assert.deepEqual(pixels(graph.surfaces.snapshot(3)), expected);
    assert.deepEqual(
      [graph.surfaces.record(3).metadataX, graph.surfaces.record(3).metadataY],
      [13, -4],
    );
    assert.equal(await invoke(0x90, 0x13, [2, 0x12345678], 0), 0);
    assert.deepEqual(pixels(graph.surfaces.snapshot(3)), expected);
    assert.equal(child.state.stackIndex, 0);
    for (let index = 7; index >= 0; index--) {
      assert.equal(await invoke(0x90, 0x12, [index], 0), 1);
      assert.equal(pop32(child.state), 1);
    }
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});

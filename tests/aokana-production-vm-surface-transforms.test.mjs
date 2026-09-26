import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {bitmapRead32, bitmapWrite32} from '../dist/engines/buriko/native/bitmap-scalar.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

const gray = (value, opaque = false) => ((opaque ? 0xff000000 : 0) | (value * 0x010101)) >>> 0;
const pixels = (bitmap) =>
  Array.from({length: bitmap.width * bitmap.height}, (_, index) =>
    bitmapRead32(
      bitmap,
      bitmap.offset + Math.floor(index / bitmap.width) * bitmap.stride + (index % bitmap.width) * 4,
    ),
  );
const fillPixels = (bitmap, values, opaque = false) => {
  values.forEach((value, index) =>
    bitmapWrite32(
      bitmap,
      bitmap.offset + Math.floor(index / bitmap.width) * bitmap.stride + (index % bitmap.width) * 4,
      gray(value, opaque),
    ),
  );
};

test('mounted VM mirrors, reduces, scales, and affine transforms distinct graph surfaces', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, child, definitions, invoke} = fixture;
  const expect = (index, width, height, format, values, opaque = false) => {
    const bitmap = graph.surfaces.snapshot(index);
    assert.ok(bitmap);
    assert.deepEqual([bitmap.width, bitmap.height, bitmap.format], [width, height, format]);
    assert.deepEqual(
      pixels(bitmap),
      values.map((value) => gray(value, opaque)),
    );
  };
  try {
    assert.equal(graph.surfaces.fonts, graph.fonts);
    assert.equal(graph.surfaces.compositor, graph.compositor);
    assert.equal(graph.surfaces.allocator, graph.allocator);
    assert.equal(graph.fonts.text, graph.text);
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) =>
            (primary === 0x90 && [0xc2, 0xc3].includes(secondary)) ||
            (primary === 0x91 && [0x18, 0x19, 0x1c].includes(secondary)),
        )
        .map(({primary, secondary}) => [primary, secondary]),
      [
        [0x90, 0xc2],
        [0x90, 0xc3],
        [0x91, 0x1c],
        [0x91, 0x18],
        [0x91, 0x19],
      ],
    );
    assert.equal(graph.surfaces.allocate(0, 3, 3, 2), 1);
    fillPixels(graph.surfaces.snapshot(0), [0, 0, 20, 1, 3, 21, 40, 43, 99], true);
    assert.equal(await invoke(0x90, 0xc2, [1, 0, 0], 0), 0);
    expect(1, 3, 3, 2, [20, 0, 0, 21, 3, 1, 99, 43, 40], true);
    assert.equal(await invoke(0x90, 0xc2, [2, 0, 1], 0), 0);
    expect(2, 3, 3, 2, [40, 43, 99, 1, 3, 21, 0, 0, 20], true);
    assert.equal(await invoke(0x90, 0xc3, [3, 0], 0), 0);
    expect(3, 2, 2, 2, [2, 21, 42, 99], true);
    assert.equal(child.state.stackIndex, 0);

    assert.equal(graph.surfaces.allocate(4, 3, 2, 2), 1);
    fillPixels(graph.surfaces.snapshot(4), [64, 128, 192, 96, 160, 224], true);
    assert.equal(await invoke(0x91, 0x1c, [5, 4, 0x18000, 0x10000, 0], 0), 0);
    expect(5, 4, 2, 2, [64, 64, 128, 128, 96, 96, 160, 160], true);
    assert.equal(await invoke(0x91, 0x1c, [6, 4, 0x18000, 0x10000, 1], 0), 0);
    expect(6, 4, 2, 2, [64, 89, 115, 140, 80, 105, 131, 156], true);
    assert.equal(child.state.stackIndex, 0);

    assert.equal(graph.surfaces.allocate(7, 2, 3, 1), 1);
    assert.equal(graph.surfaces.allocate(8, 3, 2, 1), 1);
    assert.equal(graph.surfaces.allocate(9, 3, 2, 1), 1);
    fillPixels(graph.surfaces.snapshot(7), [16, 32, 48, 64, 80, 96]);
    fillPixels(graph.surfaces.snapshot(8), [0, 0, 0, 0, 0, 0]);
    fillPixels(graph.surfaces.snapshot(9), [128, 128, 128, 128, 128, 128]);
    const affine = (destination, transparency) => [
      destination,
      0,
      0,
      7,
      65536,
      0,
      90 * 65536,
      65536,
      65536,
      transparency,
      0,
    ];
    assert.equal(await invoke(0x91, 0x19, affine(8, 0), 0), 0);
    expect(8, 3, 2, 1, [32, 64, 96, 16, 48, 80]);
    assert.equal(await invoke(0x91, 0x18, affine(9, 128), 0), 0);
    expect(9, 3, 2, 1, [80, 96, 112, 72, 88, 104]);
    assert.equal(child.state.stackIndex, 0);

    for (let index = 9; index >= 0; index--) {
      assert.equal(await invoke(0x90, 0x12, [index], 0), 1);
      assert.equal(pop32(child.state), 1);
    }
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});

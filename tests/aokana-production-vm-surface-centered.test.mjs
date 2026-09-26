import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bitmapRead32,
  bitmapWrite32,
} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

const pixels = (bitmap) =>
  Array.from({length: bitmap.width * bitmap.height}, (_, index) =>
    bitmapRead32(
      bitmap,
      bitmap.offset + Math.floor(index / bitmap.width) * bitmap.stride + (index % bitmap.width) * 4,
    ),
  );
const fill = (bitmap, pixel) => {
  for (let y = 0; y < bitmap.height; y++)
    for (let x = 0; x < bitmap.width; x++)
      bitmapWrite32(bitmap, bitmap.offset + y * bitmap.stride + x * 4, pixel(x, y));
};

test('mounted VM centers a cropped stretch and rotates graph surface pixels', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, child, definitions, fragments, invoke} = fixture;
  try {
    assert.equal(graph.surfaces.fonts, graph.fonts);
    assert.equal(graph.surfaces.compositor, graph.compositor);
    assert.equal(graph.fonts.text, graph.text);
    assert.equal(graph.resource.errors.files.text, graph.text);
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x90 && [0x1c, 0x1d].includes(secondary))
        .map(({secondary}) => secondary),
      [0x1c, 0x1d],
    );
    assert.equal(fragments.nativeDefinitions().length, definitions.length);
    for (const [index, width, height] of [
      [0, 4, 4],
      [1, 6, 2],
      [2, 2, 2],
      [3, 6, 6],
    ])
      assert.equal(graph.surfaces.allocate(index, width, height, 1), 1);

    const destination = graph.surfaces.snapshot(0);
    const source = graph.surfaces.snapshot(1);
    assert.ok(destination && source);
    const bands = [0x204060, 0x6080a0, 0xa0c0e0];
    const sentinel = 0x102030;
    fill(destination, () => sentinel);
    fill(source, (x) => bands[Math.floor(x / 2)]);
    assert.equal(await invoke(0x90, 0x1c, [0, 1, 1, 2, 2, 1, 2, 0, 2, 2], 0), 0);
    assert.deepEqual(pixels(destination), [
      sentinel,
      sentinel,
      sentinel,
      sentinel,
      sentinel,
      bands[1],
      bands[1],
      sentinel,
      sentinel,
      bands[1],
      bands[1],
      sentinel,
      sentinel,
      sentinel,
      sentinel,
      sentinel,
    ]);
    assert.equal(child.state.stackIndex, 0);

    const rotated = graph.surfaces.snapshot(2);
    const rotationSource = graph.surfaces.snapshot(3);
    assert.ok(rotated && rotationSource);
    const rows = [0x102030, 0x204060, 0x406080, 0x6080a0, 0x80a0c0, 0xa0c0e0];
    fill(rotated, () => sentinel);
    fill(rotationSource, (_x, y) => rows[y]);
    assert.equal(await invoke(0x90, 0x1d, [2, 3, 65536, 0], 0), 0);
    assert.deepEqual(pixels(rotated), [rows[2], rows[2], rows[3], rows[3]]);
    assert.equal(await invoke(0x90, 0x1d, [2, 3, 65536, 180 << 16], 0), 0);
    assert.deepEqual(pixels(rotated), [rows[4], rows[4], rows[3], rows[3]]);
    assert.equal(child.state.stackIndex, 0);
    for (const index of [3, 2, 1, 0]) assert.equal(graph.surfaces.release(index), 1);
  } finally {
    await fixture.close();
  }
});

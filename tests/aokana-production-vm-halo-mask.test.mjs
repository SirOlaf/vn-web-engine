import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {bitmapRead8, bitmapRead32} from '../dist/engines/buriko/native/bitmap-scalar.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

const gray = (value) => value * 0x010101;

test('mounted VM halo mask feeds a graph surface transition', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, memory, child, definitions, fragments, invoke} = fixture;
  const call = async (primary, secondary, args, pushed = false) => {
    assert.equal(await invoke(primary, secondary, args, 0), Number(pushed));
    const result = pushed ? pop32(child.state) : undefined;
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
    return result;
  };
  try {
    assert.equal(graph.surfaces.compositor, graph.compositor);
    assert.equal(graph.surfaces.fonts, graph.fonts);
    assert.equal(graph.surfaces.allocator, graph.allocator);
    assert.equal(graph.resource.errors.files.text, graph.text);
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x92 && secondary === 0x1b)
        .map(({secondary}) => secondary),
      [0x1b],
    );
    assert.equal(fragments.nativeDefinitions().length, definitions.length);

    const sourcePixels = [128, 128, 64].map((alpha) => ((alpha << 24) | 0x123456) >>> 0);
    const raw = new DataView(memory.globalMemory.buffer);
    for (let x = 0; x < sourcePixels.length; x++)
      raw.setUint32(0x400 + x * 4, sourcePixels[x], true);
    await call(0x90, 0x14, [0, 3, 1, 2, 0x400]);
    const source = graph.surfaces.snapshot(0);
    assert.deepEqual(
      [0, 1, 2].map((x) => bitmapRead32(source, source.offset + x * 4)),
      sourcePixels,
    );

    await call(0x92, 0x1b, [1, 0, 1]);
    const mask = graph.surfaces.snapshot(1);
    assert.deepEqual([mask.width, mask.height, mask.format], [19, 17, 3]);
    const maskAt = (x, y) => bitmapRead8(mask, mask.offset + y * mask.stride + x);
    assert.deepEqual(
      [
        [0, 0],
        [7, 7],
        [8, 8],
        [10, 8],
      ].map(([x, y]) => maskAt(x, y)),
      [0, 128, 127, 143],
    );
    assert.deepEqual(
      Array.from({length: 5}, (_, offset) => maskAt(7 + offset, 7)),
      [128, 255, 255, 192, 64],
    );

    for (const [index, value] of [
      [2, 32],
      [3, 160],
    ]) {
      await call(0x90, 0x11, [index, 19, 17, 1]);
      await call(0x90, 0x13, [index, gray(value)]);
    }
    await call(0x90, 0x19, [2, 0, 0, 3, 1, 0, 128]);
    const destination = graph.surfaces.snapshot(2);
    const colorAt = (bitmap, x, y) =>
      bitmapRead32(bitmap, bitmap.offset + y * bitmap.stride + x * 4);
    assert.deepEqual(
      [
        [0, 0],
        [7, 7],
        [8, 8],
        [10, 8],
      ].map(([x, y]) => colorAt(destination, x, y)),
      [32, 96, 95, 103].map(gray),
    );
    assert.equal(colorAt(graph.surfaces.snapshot(3), 8, 8), gray(160));
    assert.equal(maskAt(8, 8), 127);
    assert.deepEqual(
      [0, 1, 2].map((x) => bitmapRead32(source, source.offset + x * 4)),
      sourcePixels,
    );
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);

    for (const index of [3, 2, 1, 0]) assert.equal(await call(0x90, 0x12, [index], true), 1);
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});

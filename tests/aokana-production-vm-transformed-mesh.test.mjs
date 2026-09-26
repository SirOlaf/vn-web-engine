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

test('mounted VM transformed mesh copies and blends through graph surfaces', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, memory, child, definitions, fragments, invoke} = fixture;
  const call = async (secondary, args, pushed = false) => {
    assert.equal(await invoke(0x90, secondary, args, 0), Number(pushed));
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
        .filter(({primary, secondary}) => primary === 0x90 && secondary === 0xc8)
        .map(({secondary}) => secondary),
      [0xc8],
    );
    assert.equal(fragments.nativeDefinitions().length, definitions.length);

    const colors = [32, 64, 96, 128, 160, 192];
    memory.globalMemory.set(
      colors.flatMap((value) => [value, value, value]),
      0x400,
    );
    await call(0x14, [1, 3, 2, 1, 0x400]);
    const source = graph.surfaces.snapshot(1);
    assert.deepEqual(pixels(source), colors.map(gray));
    for (const index of [2, 3]) {
      await call(0x11, [index, 5, 4, 1]);
      await call(0x13, [index, gray(16)]);
    }
    const args = (destination, mode, transparency) => [
      destination,
      65536,
      65536,
      1,
      0,
      0,
      65536,
      65536,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      mode,
      transparency,
    ];
    const expected = (outside, inside) =>
      Array.from({length: 20}, (_, index) => {
        const x = index % 5;
        const y = Math.floor(index / 5);
        return gray(x >= 1 && x <= 3 && y >= 1 && y <= 2 ? inside[(y - 1) * 3 + x - 1] : outside);
      });
    const processing = graph.compositor.processing;
    assert.equal(processing, null);
    await call(0xc8, args(2, 0, 0));
    assert.deepEqual(pixels(graph.surfaces.snapshot(2)), expected(0, colors));
    assert.equal(graph.compositor.processing, processing);
    await call(0xc8, args(3, 1, 128));
    assert.deepEqual(pixels(graph.surfaces.snapshot(3)), expected(16, [24, 40, 56, 72, 88, 104]));
    assert.equal(graph.compositor.processing, processing);
    assert.deepEqual(pixels(source), colors.map(gray));
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
    for (const index of [3, 2, 1]) assert.equal(await call(0x12, [index], true), 1);
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});

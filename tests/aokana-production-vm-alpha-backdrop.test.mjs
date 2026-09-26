import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {allocateBurikoBitmap, burikoBitmapRectangle} from '../dist/engines/buriko/native/bitmap.js';
import {bitmapRead8, bitmapRead32} from '../dist/engines/buriko/native/bitmap-scalar.js';
import {BurikoMaskedBackdrop} from '../dist/engines/buriko/native/display-backdrop-mask.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM alpha extraction feeds the masked backdrop software draw', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, child, definitions, invoke, memory} = fixture;
  const output = allocateBurikoBitmap(5, 3, 1);
  const call = async (primary, secondary, args) => {
    assert.equal(await invoke(primary, secondary, args, 0), 0);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  };
  const maskPixels = (bitmap) =>
    Array.from({length: bitmap.width * bitmap.height}, (_, index) =>
      bitmapRead8(
        bitmap,
        bitmap.offset + Math.floor(index / bitmap.width) * bitmap.stride + (index % bitmap.width),
      ),
    );
  const outputPixels = () =>
    Array.from({length: 15}, (_, index) =>
      bitmapRead32(output, output.offset + Math.floor(index / 5) * output.stride + (index % 5) * 4),
    );
  const importAlpha = async (id, alphas, pointer) => {
    const bytes = new Uint8Array(12);
    const view = new DataView(bytes.buffer);
    alphas.forEach((alpha, index) =>
      view.setUint32(index * 4, ((alpha << 24) | 0x123456) >>> 0, true),
    );
    memory.globalMemory.set(bytes, pointer);
    await call(0x90, 0x14, [id, 3, 1, 2, pointer]);
    const bitmap = graph.surfaces.snapshot(id);
    assert.deepEqual([bitmap.width, bitmap.height, bitmap.format], [3, 1, 2]);
    assert.deepEqual(
      Array.from({length: 3}, (_, index) => bitmapRead32(bitmap, bitmap.offset + index * 4)),
      alphas.map((alpha) => ((alpha << 24) | 0x123456) >>> 0),
    );
  };
  try {
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x92 && secondary === 0x1a)
        .map(({secondary}) => secondary),
      [0x1a],
    );
    assert.equal(graph.manager.surfaces, graph.surfaces);
    assert.equal(graph.manager.environment.compositor, graph.compositor);
    assert.equal(graph.manager.environment.damage, graph.damage);
    assert.equal(graph.surfaces.fonts, graph.fonts);
    assert.equal(graph.fonts.text, graph.text);
    assert.equal(graph.resource.errors.files.text, graph.text);
    assert.equal(graph.manager.configureDescriptor(5, 3, 1, 15), 1);
    assert.equal(graph.device.isPresent(), false);
    await importAlpha(1, [0, 64, 255], 0x200);
    await importAlpha(2, [128, 192, 1], 0x220);
    await call(0x92, 0x1a, [3, 1, 1, 1, 2, 128]);
    const mask = graph.surfaces.snapshot(3);
    assert.deepEqual([mask.width, mask.height, mask.format], [5, 3, 3]);
    assert.deepEqual(maskPixels(mask), [0, 0, 0, 0, 0, 0, 64, 128, 128, 0, 0, 0, 0, 0, 0]);

    for (const [id, color] of [
      [4, 0x808080],
      [5, 0],
    ]) {
      await call(0x90, 0x11, [id, 5, 3, 1]);
      await call(0x90, 0x13, [id, color]);
    }
    await call(0x90, 0x4c, [1, 1]);
    graph.damage.clear();
    await call(0x90, 0x43, [0, 0, 4, 0, 0, 5, 3, 1, 64]);
    const selected = graph.manager.backdrop;
    assert.ok(selected instanceof BurikoMaskedBackdrop);
    assert.deepEqual(
      [selected.activation, selected.contentEnabled, graph.manager.backdropRenderType],
      [1, 1, 4],
    );
    assert.equal(graph.damage.fullRedraw, 1);
    assert.deepEqual(
      graph.manager.lists.snapshot(false).map(({object}) => object),
      [selected],
    );
    selected.draw(output, burikoBitmapRectangle(output), 0);
    assert.deepEqual(
      outputPixels(),
      [
        0x202020, 0x202020, 0x202020, 0x202020, 0x202020, 0x202020, 0x606060, 0x808080, 0x808080,
        0x202020, 0x202020, 0x202020, 0x202020, 0x202020, 0x202020,
      ],
    );

    for (const id of [5, 4, 3, 2, 1]) {
      assert.equal(await invoke(0x90, 0x12, [id], 0), 1);
      assert.equal(pop32(child.state), 1);
      assert.equal(child.state.stackIndex, 0);
    }
    assert.equal(child.process, null);
  } finally {
    output.storage?.release();
    await fixture.close();
  }
});

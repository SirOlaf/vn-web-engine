import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {
  allocateAokanaBitmap,
  aokanaBitmapRectangle,
} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {
  bitmapRead8,
  bitmapRead32,
} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {AokanaMaskedBackdrop} from '../dist/engines/buriko/games/aokana/native/display-backdrop-mask.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM masked backdrop consumes graph source and mask pixels', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, child, definitions, invoke, memory} = fixture;
  const output = allocateAokanaBitmap(2, 2, 1);
  const call = async (secondary, args) => {
    assert.equal(await invoke(0x90, secondary, args, 0), 0);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  };
  const pixels = () =>
    Array.from({length: 4}, (_, index) =>
      bitmapRead32(output, output.offset + Math.floor(index / 2) * output.stride + (index % 2) * 4),
    );
  const draw = () => graph.manager.backdrop.draw(output, aokanaBitmapRectangle(output), 0);
  try {
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x90 && secondary === 0x43)
        .map(({secondary}) => secondary),
      [0x43],
    );
    assert.equal(graph.manager.surfaces, graph.surfaces);
    assert.equal(graph.manager.environment.compositor, graph.compositor);
    assert.equal(graph.manager.environment.damage, graph.damage);
    assert.equal(graph.resource.errors.files.text, graph.text);
    assert.equal(graph.manager.configureDescriptor(2, 2, 1, 4), 1);
    assert.equal(graph.device.isPresent(), false);
    for (const [id, color] of [
      [0, 0x808080],
      [1, 0],
    ]) {
      await call(0x11, [id, 2, 2, 1]);
      await call(0x13, [id, color]);
    }
    await call(0x11, [2, 2, 2, 3]);
    await call(0x13, [2, 0]);
    memory.globalMemory.set([0, 64, 128, 255], 0x200);
    await call(0x14, [2, 2, 2, 3, 0x200]);
    const mask = graph.surfaces.snapshot(2);
    assert.deepEqual([mask.width, mask.height, mask.format], [2, 2, 3]);
    assert.deepEqual(
      Array.from({length: 4}, (_, index) =>
        bitmapRead8(mask, mask.offset + Math.floor(index / 2) * mask.stride + (index % 2)),
      ),
      [0, 64, 128, 255],
    );

    await call(0x4c, [1, 1]);
    graph.damage.clear();
    await call(0x43, [0, 0, 0, 0, 0, 1, -1, 0, 128]);
    const selected = graph.manager.backdrop;
    assert.ok(selected instanceof AokanaMaskedBackdrop);
    assert.deepEqual(
      [selected.activation, selected.contentEnabled, graph.manager.backdropRenderType],
      [1, 1, 4],
    );
    assert.equal(graph.damage.fullRedraw, 1);
    assert.deepEqual(
      graph.manager.lists.snapshot(false).map(({object}) => object),
      [selected],
    );
    draw();
    assert.deepEqual(pixels(), Array(4).fill(0x404040));

    graph.damage.clear();
    await call(0x43, [0, 0, 0, 0, 0, 1, 2, 1, 64]);
    assert.equal(graph.manager.backdrop, selected);
    assert.equal(graph.damage.fullRedraw, 1);
    draw();
    assert.deepEqual(pixels(), [0x202020, 0x606060, 0x808080, 0x808080]);

    for (const id of [2, 1, 0]) {
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

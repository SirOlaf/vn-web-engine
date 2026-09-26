import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {
  allocateAokanaBitmap,
  aokanaBitmapRectangle,
} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {bitmapRead32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {AokanaPanBackdrop} from '../dist/engines/buriko/games/aokana/native/display-backdrop-pan.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM pan backdrop selects four graph surfaces through software pixels', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, child, definitions, invoke} = fixture;
  const output = allocateAokanaBitmap(3, 2, 1);
  const call = async (secondary, args) => {
    assert.equal(await invoke(0x90, secondary, args, 0), 0);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  };
  const pixels = () =>
    Array.from({length: 6}, (_, index) =>
      bitmapRead32(output, output.offset + Math.floor(index / 3) * output.stride + (index % 3) * 4),
    );
  const draw = () => graph.manager.backdrop.draw(output, aokanaBitmapRectangle(output), 0);
  const colors = [0x102030, 0x405060, 0x708090, 0xa0b0c0];
  try {
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x90 && secondary === 0x42)
        .map(({secondary}) => secondary),
      [0x42],
    );
    assert.equal(graph.manager.surfaces, graph.surfaces);
    assert.equal(graph.manager.environment.compositor, graph.compositor);
    assert.equal(graph.manager.environment.damage, graph.damage);
    assert.equal(graph.resource.errors.files.text, graph.text);
    assert.equal(graph.manager.configureDescriptor(3, 2, 1, 6), 1);
    assert.equal(graph.device.isPresent(), false);
    for (const [id, color] of colors.entries()) {
      await call(0x11, [id, 3, 2, 1]);
      await call(0x13, [id, color]);
    }
    await call(0x4c, [1, 1]);
    graph.damage.clear();
    await call(0x42, [0, 1, 2, 3, 1, 1]);
    const selected = graph.manager.backdrop;
    assert.ok(selected instanceof AokanaPanBackdrop);
    assert.deepEqual(
      [selected.activation, selected.contentEnabled, graph.manager.backdropRenderType],
      [1, 1, 3],
    );
    assert.equal(graph.damage.fullRedraw, 1);
    assert.deepEqual(
      graph.manager.lists.snapshot(false).map(({object}) => object),
      [selected],
    );
    draw();
    assert.deepEqual(pixels(), [colors[0], colors[0], colors[1], colors[2], colors[2], colors[3]]);

    graph.damage.clear();
    await call(0x42, [0, 1, 2, 3, 3, 0]);
    assert.equal(graph.manager.backdrop, selected);
    assert.equal(graph.damage.fullRedraw, 1);
    draw();
    assert.deepEqual(pixels(), Array(6).fill(colors[1]));

    await call(0x42, [0, 1, 2, 3, 0, 2]);
    assert.equal(graph.manager.backdrop, selected);
    draw();
    assert.deepEqual(pixels(), Array(6).fill(colors[2]));

    for (const id of [3, 2, 1, 0]) {
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

import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {
  allocateAokanaBitmap,
  aokanaBitmapRectangle,
} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {bitmapRead32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {AokanaMosaicBackdrop} from '../dist/engines/buriko/games/aokana/native/display-backdrop-mosaic.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

const gray = (value) => value * 0x010101;

test('mounted VM mosaic backdrop samples and averages graph surface pixels', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, child, definitions, invoke, memory} = fixture;
  const output = allocateAokanaBitmap(3, 3, 1);
  const call = async (secondary, args) => {
    assert.equal(await invoke(0x90, secondary, args, 0), 0);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  };
  const pixels = (bitmap) =>
    Array.from({length: bitmap.width * bitmap.height}, (_, index) =>
      bitmapRead32(
        bitmap,
        bitmap.offset +
          Math.floor(index / bitmap.width) * bitmap.stride +
          (index % bitmap.width) * 4,
      ),
    );
  const draw = () => graph.manager.backdrop.draw(output, aokanaBitmapRectangle(output), 0);
  const values = [10, 30, 50, 50, 70, 90, 90, 110, 0];
  try {
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x90 && secondary === 0x4a)
        .map(({secondary}) => secondary),
      [0x4a],
    );
    assert.equal(graph.manager.surfaces, graph.surfaces);
    assert.equal(graph.manager.environment.compositor, graph.compositor);
    assert.equal(graph.manager.environment.damage, graph.damage);
    assert.equal(graph.resource.errors.files.text, graph.text);
    assert.equal(graph.manager.configureDescriptor(3, 3, 1, 9), 1);
    assert.equal(graph.device.isPresent(), false);
    memory.globalMemory.set(
      Uint8Array.from(values.flatMap((value) => [value, value, value])),
      0x200,
    );
    await call(0x14, [0, 3, 3, 1, 0x200]);
    assert.deepEqual(pixels(graph.surfaces.snapshot(0)), values.map(gray));
    await call(0x11, [1, 3, 3, 1]);
    await call(0x13, [1, gray(200)]);
    await call(0x4c, [1, 1]);

    graph.damage.clear();
    await call(0x4a, [0, 1, 0, 1, 0]);
    const selected = graph.manager.backdrop;
    assert.ok(selected instanceof AokanaMosaicBackdrop);
    assert.deepEqual(
      [selected.activation, selected.contentEnabled, graph.manager.backdropRenderType],
      [1, 1, 11],
    );
    assert.equal(graph.damage.fullRedraw, 1);
    assert.deepEqual(
      graph.manager.lists.snapshot(false).map(({object}) => object),
      [selected],
    );
    draw();
    assert.deepEqual(pixels(output), [10, 10, 50, 10, 10, 50, 90, 90, 0].map(gray));

    graph.damage.clear();
    await call(0x4a, [0, 1, 0, 128, 1]);
    assert.equal(graph.manager.backdrop, selected);
    assert.equal(graph.damage.fullRedraw, 1);
    draw();
    assert.deepEqual(pixels(output), Array(9).fill(0x696969));

    await call(0x4a, [0, 1, 1, 128, 1]);
    assert.equal(graph.manager.backdrop, selected);
    draw();
    assert.deepEqual(pixels(output), Array(9).fill(0x808080));

    for (const id of [1, 0]) {
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

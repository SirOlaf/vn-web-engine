import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {
  allocateAokanaBitmap,
  aokanaBitmapRectangle,
} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {bitmapRead32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {AokanaVectorBackdrop} from '../dist/engines/buriko/games/aokana/native/display-backdrop-vector.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM generated Q4 map feeds the vector backdrop software draw', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, child, definitions, invoke, memory} = fixture;
  const output = allocateAokanaBitmap(2, 2, 1);
  const call = async (primary, secondary, args) => {
    assert.equal(await invoke(primary, secondary, args, 0), 0);
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
  const colors = [0x102030, 0x405060, 0x708090, 0xa0b0c0];
  try {
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) => primary === 0x90 && [0x45, 0x4c, 0x4d].includes(secondary),
        )
        .map(({secondary}) => secondary),
      [0x45, 0x4c, 0x4d],
    );
    assert.equal(graph.manager.surfaces, graph.surfaces);
    assert.equal(graph.manager.environment.compositor, graph.compositor);
    assert.equal(graph.manager.environment.damage, graph.damage);
    assert.equal(graph.resource.errors.files.text, graph.text);
    assert.equal(graph.manager.configureDescriptor(2, 2, 1, 4), 1);
    assert.equal(graph.device.isPresent(), false);
    const bgr = new Uint8Array(colors.length * 3);
    colors.forEach((color, index) => {
      bgr[index * 3] = color & 255;
      bgr[index * 3 + 1] = (color >>> 8) & 255;
      bgr[index * 3 + 2] = (color >>> 16) & 255;
    });
    memory.globalMemory.set(bgr, 0x200);
    await call(0x90, 0x14, [0, 2, 2, 1, 0x200]);
    assert.deepEqual(pixels(graph.surfaces.snapshot(0)), colors);
    await call(0x90, 0x11, [1, 2, 2, 4]);
    await call(0x91, 0x16, [1, 4, 0, 1, 4, 0, 1]);
    const map = graph.surfaces.snapshot(1);
    assert.deepEqual([map.width, map.height, map.format], [2, 2, 4]);
    assert.deepEqual(
      Array.from({length: 4}, (_, index) => {
        const offset =
          map.offset + Math.floor(index / 2) * map.stride + (index % 2) * map.bytesPerPixel;
        return [
          map.storage.view.getInt16(offset, true),
          map.storage.view.getInt16(offset + 2, true),
        ];
      }),
      [
        [0, 0],
        [0, 16],
        [16, 0],
        [16, 16],
      ],
    );
    await call(0x90, 0x4c, [1, 1]);

    graph.damage.clear();
    await call(0x90, 0x45, [0, 1, -1, 0, 0]);
    const selected = graph.manager.backdrop;
    assert.ok(selected instanceof AokanaVectorBackdrop);
    assert.deepEqual(
      [selected.activation, selected.contentEnabled, graph.manager.backdropRenderType],
      [1, 1, 6],
    );
    assert.equal(graph.damage.fullRedraw, 1);
    assert.deepEqual(
      graph.manager.lists.snapshot(false).map(({object}) => object),
      [selected],
    );
    draw();
    assert.deepEqual(pixels(output), colors);
    assert.equal(await invoke(0x90, 0x4d, [], 0), 1);
    assert.equal(pop32(child.state), 6);
    assert.equal(child.state.stackIndex, 0);

    graph.damage.clear();
    await call(0x90, 0x45, [0, 1, -1, 256, 0]);
    assert.equal(graph.manager.backdrop, selected);
    assert.equal(graph.damage.fullRedraw, 1);
    draw();
    assert.deepEqual(pixels(output), [colors[0], colors[3], colors[3], 0]);

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

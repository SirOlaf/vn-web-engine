import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {
  allocateAokanaBitmap,
  aokanaBitmapRectangle,
} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {bitmapRead32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {AokanaStretchBackdrop} from '../dist/engines/buriko/games/aokana/native/display-backdrop-stretch.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM stretch backdrop samples graph source windows at bound blend values', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, child, definitions, invoke, memory} = fixture;
  const call = async (secondary, args) => {
    assert.equal(await invoke(0x90, secondary, args, 0), 0);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  };
  const colors = [0x204060, 0x6080a0, 0xa0c0e0];
  try {
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x90 && secondary === 0x48)
        .map(({secondary}) => secondary),
      [0x48],
    );
    assert.equal(graph.manager.surfaces, graph.surfaces);
    assert.equal(graph.manager.environment.compositor, graph.compositor);
    assert.equal(graph.manager.environment.damage, graph.damage);
    assert.equal(graph.resource.errors.files.text, graph.text);
    assert.equal(graph.manager.configureDescriptor(2, 2, 1, 4), 1);
    assert.equal(graph.device.isPresent(), false);
    const sourceColors = Array.from(
      {length: 12},
      (_, index) => colors[Math.floor((index % 6) / 2)],
    );
    const bgr = new Uint8Array(sourceColors.length * 3);
    sourceColors.forEach((color, index) => {
      bgr[index * 3] = color & 255;
      bgr[index * 3 + 1] = (color >>> 8) & 255;
      bgr[index * 3 + 2] = (color >>> 16) & 255;
    });
    memory.globalMemory.set(bgr, 0x200);
    await call(0x14, [0, 6, 2, 1, 0x200]);
    const source = graph.surfaces.snapshot(0);
    assert.deepEqual([source.width, source.height, source.format], [6, 2, 1]);
    assert.deepEqual(
      Array.from({length: 12}, (_, index) =>
        bitmapRead32(
          source,
          source.offset + Math.floor(index / 6) * source.stride + (index % 6) * 4,
        ),
      ),
      sourceColors,
    );
    await call(0x4c, [1, 1]);

    graph.damage.clear();
    await call(0x48, [0, 0, 0, 2, 2]);
    const selected = graph.manager.backdrop;
    assert.ok(selected instanceof AokanaStretchBackdrop);
    assert.deepEqual(
      [selected.activation, selected.contentEnabled, graph.manager.backdropRenderType],
      [1, 1, 9],
    );
    assert.deepEqual(selected.position(), {x: 0, y: 0});
    assert.equal(graph.damage.fullRedraw, 1);
    assert.deepEqual(
      graph.manager.lists.snapshot(false).map(({object}) => object),
      [selected],
    );
    assert.equal(await invoke(0x90, 0x4d, [], 0), 1);
    assert.equal(pop32(child.state), 9);
    assert.equal(child.state.stackIndex, 0);

    await call(0x38, [0, 0x102, 4, 0x00020002]);
    for (const [blend, color] of [
      [0, colors[0]],
      [128, colors[1]],
      [256, colors[2]],
    ]) {
      await call(0x32, [0, blend]);
      const output = allocateAokanaBitmap(2, 2, 1);
      try {
        selected.draw(output, aokanaBitmapRectangle(output), 0);
        assert.deepEqual(
          Array.from({length: 4}, (_, index) =>
            bitmapRead32(
              output,
              output.offset + Math.floor(index / 2) * output.stride + (index % 2) * 4,
            ),
          ),
          Array(4).fill(color),
        );
      } finally {
        output.storage?.release();
      }
    }
    await call(0x48, [0, 0, 0, 2, 2]);
    assert.equal(graph.manager.backdrop, selected);
    assert.equal(child.process, null);
    assert.equal(await invoke(0x90, 0x12, [0], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});

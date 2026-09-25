import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {
  allocateAokanaBitmap,
  aokanaBitmapRectangle,
} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {bitmapRead32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {AokanaRotationBackdrop} from '../dist/engines/buriko/games/aokana/native/display-backdrop-rotation.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM rotation backdrop applies base angle and scale envelope to graph pixels', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, child, definitions, invoke, memory} = fixture;
  const call = async (secondary, args) => {
    assert.equal(await invoke(0x90, secondary, args, 0), 0);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  };
  const colors = [0x102030, 0x204060, 0x406080, 0x6080a0, 0x80a0c0, 0xa0c0e0];
  const draw = () => {
    const output = allocateAokanaBitmap(2, 2, 1);
    try {
      graph.manager.backdrop.draw(output, aokanaBitmapRectangle(output), 0);
      return Array.from({length: 4}, (_, index) =>
        bitmapRead32(
          output,
          output.offset + Math.floor(index / 2) * output.stride + (index % 2) * 4,
        ),
      );
    } finally {
      output.storage?.release();
    }
  };
  try {
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x90 && secondary === 0x49)
        .map(({secondary}) => secondary),
      [0x49],
    );
    assert.equal(graph.manager.surfaces, graph.surfaces);
    assert.equal(graph.manager.environment.compositor, graph.compositor);
    assert.equal(graph.manager.environment.damage, graph.damage);
    assert.equal(graph.resource.errors.files.text, graph.text);
    assert.equal(graph.manager.configureDescriptor(2, 2, 1, 4), 1);
    assert.equal(graph.device.isPresent(), false);
    const sourceColors = Array.from({length: 36}, (_, index) => colors[Math.floor(index / 6)]);
    const bgr = new Uint8Array(sourceColors.length * 3);
    sourceColors.forEach((color, index) => {
      bgr[index * 3] = color & 255;
      bgr[index * 3 + 1] = (color >>> 8) & 255;
      bgr[index * 3 + 2] = (color >>> 16) & 255;
    });
    memory.globalMemory.set(bgr, 0x200);
    await call(0x14, [0, 6, 6, 1, 0x200]);
    const source = graph.surfaces.snapshot(0);
    assert.deepEqual([source.width, source.height, source.format], [6, 6, 1]);
    assert.deepEqual(
      Array.from({length: 36}, (_, index) =>
        bitmapRead32(
          source,
          source.offset + Math.floor(index / 6) * source.stride + (index % 6) * 4,
        ),
      ),
      sourceColors,
    );
    await call(0x4c, [1, 1]);

    graph.damage.clear();
    await call(0x49, [0, 65536, 0]);
    const selected = graph.manager.backdrop;
    assert.ok(selected instanceof AokanaRotationBackdrop);
    assert.deepEqual(
      [selected.activation, selected.contentEnabled, graph.manager.backdropRenderType],
      [1, 1, 10],
    );
    assert.equal(graph.damage.fullRedraw, 1);
    assert.deepEqual(
      graph.manager.lists.snapshot(false).map(({object}) => object),
      [selected],
    );
    assert.equal(await invoke(0x90, 0x4d, [], 0), 1);
    assert.equal(pop32(child.state), 10);
    assert.equal(child.state.stackIndex, 0);
    await call(0x32, [0, 0]);
    assert.deepEqual(draw(), [colors[2], colors[2], colors[3], colors[3]]);

    await call(0x38, [0, 0x101, 65536, 180 << 16]);
    assert.deepEqual(draw(), [colors[4], colors[4], colors[3], colors[3]]);
    await call(0x38, [0, 0x101, 65536, 0]);
    await call(0x38, [0, 0x80, 65536, 0]);
    await call(0x32, [0, 256]);
    assert.deepEqual(draw(), Array(4).fill(colors[3]));

    await call(0x49, [0, 65536, 0]);
    assert.equal(graph.manager.backdrop, selected);
    assert.equal(child.process, null);
    assert.equal(await invoke(0x90, 0x12, [0], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {
  allocateAokanaBitmap,
  aokanaBitmapRectangle,
} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {bitmapRead32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {AokanaBlurBackdrop} from '../dist/engines/buriko/games/aokana/native/display-backdrop-blur.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

const gray = (value) => value * 0x010101;

test('mounted VM blur backdrop transforms graph surface rows in software', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, child, definitions, invoke, memory} = fixture;
  const call = async (secondary, args) => {
    assert.equal(await invoke(0x90, secondary, args, 0), 0);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  };
  const draw = () => {
    const output = allocateAokanaBitmap(3, 2, 1);
    try {
      graph.manager.backdrop.draw(output, aokanaBitmapRectangle(output), 0);
      return Array.from({length: 6}, (_, index) =>
        bitmapRead32(
          output,
          output.offset + Math.floor(index / 3) * output.stride + (index % 3) * 4,
        ),
      );
    } finally {
      output.storage?.release();
    }
  };
  try {
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x90 && secondary === 0x46)
        .map(({secondary}) => secondary),
      [0x46],
    );
    assert.equal(graph.manager.surfaces, graph.surfaces);
    assert.equal(graph.manager.environment.compositor, graph.compositor);
    assert.equal(graph.manager.environment.damage, graph.damage);
    assert.equal(graph.resource.errors.files.text, graph.text);
    assert.equal(graph.manager.configureDescriptor(3, 2, 1, 6), 1);
    assert.equal(graph.device.isPresent(), false);
    const sourceValues = [30, 60, 90, 30, 60, 90];
    memory.globalMemory.set(
      Uint8Array.from(sourceValues.flatMap((value) => [value, value, value])),
      0x200,
    );
    await call(0x14, [0, 3, 2, 1, 0x200]);
    const source = graph.surfaces.snapshot(0);
    assert.deepEqual([source.width, source.height, source.format], [3, 2, 1]);
    assert.deepEqual(
      Array.from({length: 6}, (_, index) =>
        bitmapRead32(
          source,
          source.offset + Math.floor(index / 3) * source.stride + (index % 3) * 4,
        ),
      ),
      sourceValues.map(gray),
    );
    await call(0x4c, [1, 1]);

    graph.damage.clear();
    await call(0x46, [0, 0, 0]);
    const selected = graph.manager.backdrop;
    assert.ok(selected instanceof AokanaBlurBackdrop);
    assert.deepEqual(
      [selected.activation, selected.contentEnabled, graph.manager.backdropRenderType],
      [1, 1, 7],
    );
    assert.equal(graph.damage.fullRedraw, 1);
    assert.deepEqual(
      graph.manager.lists.snapshot(false).map(({object}) => object),
      [selected],
    );
    assert.equal(await invoke(0x90, 0x4d, [], 0), 1);
    assert.equal(pop32(child.state), 7);
    assert.equal(child.state.stackIndex, 0);
    assert.deepEqual(draw(), [30, 60, 90, 30, 60, 90].map(gray));

    graph.damage.clear();
    await call(0x46, [0, 0, 1]);
    assert.equal(graph.manager.backdrop, selected);
    assert.equal(graph.damage.fullRedraw, 1);
    assert.deepEqual(draw(), [30, 60, 50, 30, 60, 50].map(gray));

    graph.damage.clear();
    await call(0x46, [0, 1, 1]);
    assert.equal(graph.manager.backdrop, selected);
    assert.equal(graph.damage.fullRedraw, 1);
    assert.deepEqual(draw(), [40, 60, 80, 40, 60, 80].map(gray));

    assert.equal(await invoke(0x90, 0x12, [0], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});

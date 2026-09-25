import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {
  allocateAokanaBitmap,
  aokanaBitmapRectangle,
} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {bitmapRead32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {AokanaNormalBackdrop} from '../dist/engines/buriko/games/aokana/native/display-backdrop.js';
import {AokanaBlendBackdrop} from '../dist/engines/buriko/games/aokana/native/display-backdrop-blend.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM normal and blend backdrops draw graph surfaces in software', async () => {
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
  try {
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x90 && [0x40, 0x41].includes(secondary))
        .map(({secondary}) => secondary),
      [0x40, 0x41],
    );
    assert.equal(graph.manager.surfaces, graph.surfaces);
    assert.equal(graph.manager.environment.compositor, graph.compositor);
    assert.equal(graph.manager.environment.damage, graph.damage);
    assert.equal(graph.resource.errors.files.text, graph.text);
    assert.equal(graph.manager.configureDescriptor(3, 2, 1, 6), 1);
    assert.equal(graph.device.isPresent(), false);
    for (const [id, color] of [
      [0, 0x204060],
      [1, 0x6080a0],
    ]) {
      await call(0x11, [id, 3, 2, 1]);
      await call(0x13, [id, color]);
    }
    await call(0x4c, [1, 1]);
    await call(0x40, [0]);
    const normal = graph.manager.backdrop;
    assert.ok(normal instanceof AokanaNormalBackdrop);
    assert.equal(graph.manager.backdropRenderType, 1);
    draw();
    assert.deepEqual(pixels(), Array(6).fill(0x204060));

    graph.damage.clear();
    await call(0x41, [0, 1, 128]);
    const blended = graph.manager.backdrop;
    assert.ok(blended instanceof AokanaBlendBackdrop);
    assert.notEqual(blended, normal);
    assert.deepEqual(
      [blended.activation, blended.contentEnabled, graph.manager.backdropRenderType],
      [1, 1, 2],
    );
    assert.equal(graph.damage.fullRedraw, 1);
    assert.deepEqual(
      graph.manager.lists.snapshot(false).map(({object}) => object),
      [blended],
    );
    draw();
    assert.deepEqual(pixels(), Array(6).fill(0x406080));

    await call(0x41, [0, 0x7000, 128]);
    assert.equal(graph.manager.backdrop, blended);
    draw();
    assert.deepEqual(pixels(), Array(6).fill(0x102030));
    await call(0x41, [0, 0x7001, 128]);
    assert.equal(graph.manager.backdrop, blended);
    draw();
    assert.deepEqual(pixels(), Array(6).fill(0x8f9faf));

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

import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {bitmapRead32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {AokanaWindowDisplayObject} from '../dist/engines/buriko/games/aokana/native/display-window.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM selection records draw through the shared Window text layer', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, child, definitions, invoke, memory} = fixture;
  const view = new DataView(memory.globalMemory.buffer);
  const words = (offset, values) =>
    values.forEach((value, index) => view.setInt32(offset + index * 4, value, true));
  const call = async (secondary, args) => {
    assert.equal(await invoke(0x90, secondary, args, 0), 0);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  };
  const pixel = (bitmap, x, y) =>
    bitmapRead32(bitmap, bitmap.offset + y * bitmap.stride + x * 4) & 0xffffff;
  try {
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x90 && [0xb4, 0xb5].includes(secondary))
        .map(({secondary}) => secondary),
      [0xb4, 0xb5],
    );
    assert.equal(graph.windowState.manager, graph.manager);
    assert.equal(graph.manager.surfaces, graph.surfaces);
    assert.equal(graph.manager.environment.compositor, graph.compositor);
    assert.equal(graph.manager.environment.damage, graph.damage);
    assert.equal(graph.resource.errors.files.text, graph.text);
    assert.equal(graph.manager.configureDescriptor(64, 32, 1, 64 * 32), 1);
    assert.equal(graph.device.isPresent(), false);

    assert.equal(await invoke(0x90, 0x80, [32, 24], 0), 1);
    const handle = pop32(child.state);
    const window = graph.manager.find('window', handle);
    assert.ok(window instanceof AokanaWindowDisplayObject);
    await call(0x88, [handle, 3, 2, 26, 19]);
    assert.deepEqual(window.getTextRectangle(), {left: 3, top: 2, right: 28, bottom: 20});
    for (const [id, color] of [
      [0, 0x800000],
      [1, 0x008000],
    ]) {
      await call(0x11, [id, 4, 4, 1]);
      await call(0x13, [id, color]);
    }

    words(32, [1, 2, 0, -1, 10, 6, 1, -1]);
    words(128, [1, 2, 1, -1]);
    words(192, [10, 6, 0, -1]);
    for (const [secondary, pointer, expected] of [
      [0xb4, 32, [0x800000, 0x008000]],
      [0xb5, 128, [0x008000, 0x800000]],
    ]) {
      graph.damage.clear();
      await call(secondary, [handle, 2, pointer]);
      assert.deepEqual(
        [pixel(window.compositionBitmap, 5, 5), pixel(window.compositionBitmap, 14, 9)],
        expected,
      );
      assert.deepEqual([pixel(window.textBitmap, 5, 5), pixel(window.textBitmap, 14, 9)], expected);
      assert.deepEqual(graph.damage.snapshot(), [
        {key: window.sortKey(), rectangle: window.textBitmapRectangle()},
      ]);
    }

    await call(0x83, [2, handle]);
    const captured = graph.surfaces.snapshot(2);
    assert.ok(captured);
    assert.deepEqual([captured.width, captured.height, captured.format], [32, 24, 2]);
    assert.deepEqual([pixel(captured, 5, 5), pixel(captured, 14, 9)], [0x008000, 0x800000]);
    await call(0x81, [handle]);
    assert.equal(graph.manager.find('window', handle), null);
    for (const id of [2, 1, 0]) {
      assert.equal(await invoke(0x90, 0x12, [id], 0), 1);
      assert.equal(pop32(child.state), 1);
      assert.equal(child.state.stackIndex, 0);
    }
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});

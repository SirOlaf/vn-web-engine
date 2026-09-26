import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {bitmapRead32} from '../dist/engines/buriko/native/bitmap-scalar.js';
import {BurikoWindowDisplayObject} from '../dist/engines/buriko/native/display-window.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM draws an immediate icon description into the shared Window text layer', async () => {
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
        .filter(
          ({primary, secondary}) =>
            primary === 0x90 && (secondary === 0xb6 || (secondary >= 0xb8 && secondary <= 0xbf)),
        )
        .map(({secondary}) => secondary),
      [0xb6, 0xb8, 0xb9, 0xba, 0xbc, 0xbd, 0xbe, 0xbf],
    );
    assert.equal(graph.windowState.manager, graph.manager);
    assert.equal(graph.manager.surfaces, graph.surfaces);
    assert.equal(graph.manager.environment.compositor, graph.compositor);
    assert.equal(graph.manager.environment.damage, graph.damage);
    assert.equal(graph.manager.configureDescriptor(64, 32, 1, 64 * 32), 1);
    assert.equal(graph.device.isPresent(), false);

    assert.equal(await invoke(0x90, 0x80, [32, 32], 0), 1);
    const handle = pop32(child.state);
    const window = graph.manager.find('window', handle);
    assert.ok(window instanceof BurikoWindowDisplayObject);
    await call(0x88, [handle, 3, 2, 26, 27]);
    for (const [id, color] of [
      [0, 0x110000],
      [1, 0x002200],
      [2, 0x000033],
    ]) {
      await call(0x11, [id, 3, 2, 1]);
      await call(0x13, [id, color]);
    }

    words(32, [1, 128, 0, 1, 0, 0, 0, 0]);
    words(128, [2, 256, 0, 1, 0, 0, -1, 0, 0, -1, 0, 0, -1]);
    for (const [index, x] of [
      [0, 2],
      [1, 8],
    ])
      words(256 + index * 60, [1, x, 2, 0, 1, 2, -1, 0, 0, -1, 0, 0, -1, 0, 0]);

    graph.damage.clear();
    assert.equal(await invoke(0x90, 0xb6, [handle, 32], 0), 1);
    assert.equal(pop32(child.state), 0);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
    for (const bitmap of [window.textBitmap, window.compositionBitmap])
      assert.deepEqual([pixel(bitmap, 5, 4), pixel(bitmap, 11, 4)], [0x002200, 0x110000]);
    assert.deepEqual(graph.damage.snapshot(), [
      {key: window.sortKey(), rectangle: window.textBitmapRectangle()},
    ]);
    assert.equal(window.getOwner(), null);
    assert.deepEqual([...window.children()], []);

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

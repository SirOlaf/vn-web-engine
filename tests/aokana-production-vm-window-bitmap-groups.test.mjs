import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {bitmapRead32} from '../dist/engines/buriko/native/bitmap-scalar.js';
import {BurikoWindowDisplayObject} from '../dist/engines/buriko/native/display-window.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM bitmap groups compose and replace real Window inner Sprites', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, child, definitions, invoke, memory} = fixture;
  const view = new DataView(memory.globalMemory.buffer);
  const words = (offset, values) => {
    values.forEach((value, index) => view.setInt32(offset + index * 4, value, true));
  };
  const call = async (secondary, args) => {
    assert.equal(await invoke(0x90, secondary, args, 0), 0);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  };
  try {
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x90 && secondary === 0xb7)
        .map(({secondary}) => secondary),
      [0xb7],
    );
    assert.equal(graph.windowState.manager, graph.manager);
    assert.equal(graph.manager.surfaces, graph.surfaces);
    assert.equal(graph.manager.environment.compositor, graph.compositor);
    assert.equal(graph.device.isPresent(), false);
    assert.equal(graph.manager.configureDescriptor(64, 32, 1, 64 * 32), 1);

    assert.equal(await invoke(0x90, 0x80, [32, 24], 0), 1);
    const handle = pop32(child.state);
    const window = graph.manager.find('window', handle);
    assert.ok(window instanceof BurikoWindowDisplayObject);
    assert.equal(window.windowState, graph.windowState);
    for (const [id, color] of [
      [0, 0x800000],
      [1, 0x008000],
    ]) {
      await call(0x11, [id, 4, 4, 1]);
      await call(0x13, [id, color]);
    }

    words(32, [1, 128, 0, 0, 0, 0, 0, 0, 0, 0]);
    words(128, [3, 3, 256, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    for (let i = 0; i < 3; i++) {
      const unit = Array(49).fill(0);
      unit[0] = 0;
      unit[1] = 1;
      unit[2] = 2 + i * 8;
      unit[3] = 3;
      unit[4] = unit[5] = 1;
      unit[8] = 0;
      unit[10] = 1;
      unit[48] = i === 2 ? 0x40 : i === 1 ? 2 : 0;
      words(256 + i * 0xc4, unit);
    }
    const pixel = (x, y) => {
      const bitmap = window.compositionBitmap;
      return bitmapRead32(bitmap, bitmap.offset + y * bitmap.stride + x * 4) & 0xffffff;
    };
    const drawGroups = async () => {
      assert.equal(await invoke(0x90, 0xb7, [handle, 32], 0), 1);
      assert.equal(pop32(child.state), 0);
      assert.equal(child.state.stackIndex, 0);
      assert.equal(child.process, null);
    };

    await drawGroups();
    assert.deepEqual([pixel(3, 4), pixel(11, 4), pixel(19, 4)], [0x800000, 0x008000, 0]);
    view.setInt32(128 + 3 * 4, 0, true);
    await drawGroups();
    assert.equal(graph.manager.find('window', handle), window);
    assert.deepEqual([pixel(3, 4), pixel(11, 4), pixel(19, 4)], [0x008000, 0x800000, 0]);

    await call(0x81, [handle]);
    assert.equal(graph.manager.find('window', handle), null);
    for (const id of [1, 0]) {
      assert.equal(await invoke(0x90, 0x12, [id], 0), 1);
      assert.equal(pop32(child.state), 1);
      assert.equal(child.state.stackIndex, 0);
    }
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});

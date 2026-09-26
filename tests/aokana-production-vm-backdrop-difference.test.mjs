import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {allocateBurikoBitmap, burikoBitmapRectangle} from '../dist/engines/buriko/native/bitmap.js';
import {bitmapRead32} from '../dist/engines/buriko/native/bitmap-scalar.js';
import {BurikoDifferenceBackdrop} from '../dist/engines/buriko/native/display-backdrop-difference.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted difference backdrop tracks source changes and draws through shared software surfaces', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, child, definitions, invoke, memory} = fixture;
  const output = allocateBurikoBitmap(32, 24, 1);
  const bounds = burikoBitmapRectangle(output);
  const call = async (secondary, args) => {
    assert.equal(await invoke(0x90, secondary, args, 0), 0);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  };
  const pixel = (x, y) => bitmapRead32(output, output.offset + y * output.stride + x * 4);
  const sortedDamage = () =>
    graph.damage
      .snapshot()
      .map(({rectangle}) => rectangle)
      .toSorted((a, b) => a.top - b.top || a.left - b.left);
  try {
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x90 && secondary === 0x44)
        .map(({secondary}) => secondary),
      [0x44],
    );
    assert.equal(graph.manager.surfaces, graph.surfaces);
    assert.equal(graph.manager.environment.compositor, graph.compositor);
    assert.equal(graph.manager.environment.damage, graph.damage);
    assert.equal(graph.resource.errors.files.text, graph.text);
    assert.equal(graph.manager.configureDescriptor(32, 24, 1, 32 * 24), 1);
    graph.manager.bindDisplayContext({bitmap: output, bounds});
    assert.equal(graph.device.isPresent(), false);

    for (const id of [0, 1]) {
      await call(0x11, [id, 32, 24, 1]);
      await call(0x13, [id, 0]);
    }
    const raw = new Uint8Array(32 * 24 * 3);
    const write = (x, y, color) => {
      const at = (y * 32 + x) * 3;
      raw[at] = color & 255;
      raw[at + 1] = (color >>> 8) & 255;
      raw[at + 2] = (color >>> 16) & 255;
    };
    write(2, 5, 0x112233);
    write(3, 5, 0x112233);
    write(7, 8, 0x445566);
    memory.globalMemory.set(raw, 0x200);
    await call(0x14, [1, 32, 24, 1, 0x200]);
    const second = graph.surfaces.snapshot(1);
    assert.ok(second);
    assert.deepEqual([second.width, second.height, second.format], [32, 24, 1]);
    assert.deepEqual(
      [
        bitmapRead32(second, second.offset + 5 * second.stride + 2 * 4),
        bitmapRead32(second, second.offset + 5 * second.stride + 3 * 4),
        bitmapRead32(second, second.offset + 8 * second.stride + 7 * 4),
      ],
      [0x112233, 0x112233, 0x445566],
    );
    const ids = new DataView(memory.globalMemory.buffer);
    ids.setUint32(0x100, 0, true);
    ids.setUint32(0x104, 1, true);
    await call(0x4c, [1, 1]);

    graph.damage.clear();
    await call(0x44, [2, 0x100, 0]);
    const selected = graph.manager.backdrop;
    assert.ok(selected instanceof BurikoDifferenceBackdrop);
    assert.equal(selected.surfaces, graph.surfaces);
    assert.deepEqual(
      [selected.activation, selected.contentEnabled, graph.manager.backdropRenderType],
      [1, 1, 5],
    );
    assert.deepEqual(
      graph.manager.lists.snapshot(false).map(({object}) => object),
      [selected],
    );
    assert.equal(graph.damage.fullRedraw, 1);
    assert.equal(await invoke(0x90, 0x4d, [], 0), 1);
    assert.equal(pop32(child.state), 5);
    assert.equal(child.state.stackIndex, 0);
    selected.draw(output, bounds, 0);
    assert.deepEqual([pixel(2, 5), pixel(3, 5), pixel(7, 8)], [0, 0, 0]);
    // The normal renderer sends this public finish notification after a software draw.
    selected.notify(0xf0000000, 0, 0);

    graph.damage.clear();
    await call(0x32, [0, 1]);
    assert.equal(graph.damage.fullRedraw, 0);
    assert.deepEqual(sortedDamage(), [
      {left: 2, top: 5, right: 3, bottom: 5},
      {left: 7, top: 8, right: 7, bottom: 8},
    ]);
    selected.draw(output, bounds, 0);
    assert.deepEqual(
      [pixel(2, 5), pixel(3, 5), pixel(7, 8), pixel(20, 10)],
      [0x112233, 0x112233, 0x445566, 0],
    );
    selected.notify(0xf0000000, 0, 0);

    graph.damage.clear();
    await call(0x32, [0, 0]);
    assert.equal(graph.damage.fullRedraw, 0);
    assert.deepEqual(sortedDamage(), [
      {left: 2, top: 5, right: 3, bottom: 5},
      {left: 7, top: 8, right: 7, bottom: 8},
    ]);
    selected.draw(output, bounds, 0);
    assert.deepEqual([pixel(2, 5), pixel(3, 5), pixel(7, 8)], [0, 0, 0]);

    for (const id of [1, 0]) {
      assert.equal(await invoke(0x90, 0x12, [id], 0), 1);
      assert.equal(pop32(child.state), 1);
    }
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
    assert.equal(graph.device.isPresent(), false);
  } finally {
    await fixture.close();
    output.storage?.release();
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {allocateBurikoBitmap, burikoBitmapRectangle} from '../dist/engines/buriko/native/bitmap.js';
import {bitmapRead32} from '../dist/engines/buriko/native/bitmap-scalar.js';
import {BurikoRippleBackdrop} from '../dist/engines/buriko/native/display-backdrop.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

const gray = (value) => Math.imul(value, 0x01010101) >>> 0;

test('mounted VM ripple backdrop consumes shared coefficients and imported distance vectors', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, child, definitions, invoke, memory} = fixture;
  const output = allocateBurikoBitmap(3, 2, 2);
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
  const mapWords = () => {
    const map = graph.surfaces.snapshot(4);
    assert.deepEqual([map.width, map.height, map.format], [3, 2, 6]);
    return Array.from({length: 6}, (_, index) => {
      const offset = map.offset + Math.floor(index / 3) * map.stride + (index % 3) * 6;
      map.storage.range(offset, 6, true);
      return [
        map.storage.view.getInt16(offset, true),
        map.storage.view.getInt16(offset + 2, true),
        map.storage.view.getUint16(offset + 4, true),
      ];
    });
  };
  const importMap = async (dx) => {
    const bytes = new Uint8Array(36);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < 6; index++) {
      view.setInt16(index * 6, dx, true);
      view.setInt16(index * 6 + 2, 0, true);
      view.setUint16(index * 6 + 4, 1, true);
    }
    memory.globalMemory.set(bytes, 0x300);
    await call(0x90, 0x14, [4, 3, 2, 6, 0x300]);
    assert.deepEqual(
      mapWords(),
      Array.from({length: 6}, () => [dx, 0, 1]),
    );
  };
  const draw = () => graph.manager.backdrop.draw(output, burikoBitmapRectangle(output), 0);
  try {
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x90 && secondary === 0x47)
        .map(({secondary}) => secondary),
      [0x47],
    );
    assert.equal(graph.manager.surfaces, graph.surfaces);
    assert.equal(graph.manager.environment.compositor, graph.compositor);
    assert.equal(graph.manager.environment.damage, graph.damage);
    assert.equal(graph.resource.errors.files.text, graph.text);
    assert.equal(graph.manager.configureDescriptor(3, 2, 2, 6), 1);
    assert.equal(graph.device.isPresent(), false);
    const sourceValues = [10, 20, 30, 40, 50, 60, 70, 80].map(gray);
    const sourceBytes = new Uint8Array(32);
    const sourceView = new DataView(sourceBytes.buffer);
    sourceValues.forEach((value, index) => sourceView.setUint32(index * 4, value, true));
    memory.globalMemory.set(sourceBytes, 0x200);
    await call(0x90, 0x14, [3, 4, 2, 2, 0x200]);
    assert.deepEqual(pixels(graph.surfaces.snapshot(3)), sourceValues);
    await importMap(256);
    assert.equal(await invoke(0x92, 0x00, [2, 1, 256, 2, 2], 0), 0);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
    const coefficients = graph.surfaces.coefficientTables.query(2, 0, 1);
    assert.equal(coefficients.status, 0);
    assert.equal(coefficients.available, 1);
    await call(0x90, 0x4c, [1, 1]);

    graph.damage.clear();
    await call(0x90, 0x47, [3, 4, 1, 2, 256]);
    const selected = graph.manager.backdrop;
    assert.ok(selected instanceof BurikoRippleBackdrop);
    assert.deepEqual(
      [selected.activation, selected.contentEnabled, graph.manager.backdropRenderType],
      [1, 1, 8],
    );
    assert.equal(graph.damage.fullRedraw, 1);
    assert.deepEqual(
      graph.manager.lists.snapshot(false).map(({object}) => object),
      [selected],
    );
    assert.equal(selected.sampling, 0);
    assert.equal(await invoke(0x90, 0x4d, [], 0), 1);
    assert.equal(pop32(child.state), 8);
    assert.equal(child.state.stackIndex, 0);
    draw();
    assert.deepEqual(pixels(output), [20, 30, 40, 60, 70, 80].map(gray));

    await importMap(128);
    await call(0x90, 0x38, [0, 0xff, 1, 0]);
    graph.damage.clear();
    await call(0x90, 0x47, [3, 4, 1, 2, 256]);
    assert.equal(graph.manager.backdrop, selected);
    assert.equal(selected.sampling, 1);
    assert.equal(graph.damage.fullRedraw, 1);
    draw();
    assert.deepEqual(pixels(output), [15, 25, 35, 55, 65, 75].map(gray));

    for (const id of [4, 3]) {
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

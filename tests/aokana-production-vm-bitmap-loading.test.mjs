import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

function packedRgba(width, height, pixels, metadata) {
  const bytes = new Uint8Array(16 + pixels.length * 4);
  const header = new DataView(bytes.buffer);
  header.setUint16(0, width, true);
  header.setUint16(2, height, true);
  header.setUint16(4, 32, true);
  header.setUint16(10, 1, true);
  header.setUint16(12, metadata[0], true);
  header.setUint16(14, metadata[1], true);
  for (const [index, pixel] of pixels.entries()) header.setUint32(16 + index * 4, pixel, true);
  return bytes;
}

function bitmapPixels(bitmap) {
  return Array.from({length: bitmap.width * bitmap.height}, (_, index) =>
    bitmap.storage.view.getUint32(
      bitmap.offset + Math.floor(index / bitmap.width) * bitmap.stride + (index % bitmap.width) * 4,
      true,
    ),
  );
}

test('mounted VM preloads and loads packed bitmap resources into its shared surface table', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, memory, child, definitions, encode, invoke} = fixture;
  try {
    assert.equal(graph.bitmapLoadState.input, graph.input);
    assert.equal(graph.bitmapLoadState.clock, graph.clock);
    assert.equal(graph.bitmapLoading.surfaces, graph.surfaces);
    assert.equal(graph.bitmapLoading.resources, graph.resource.loading);
    assert.equal(graph.bitmapLoading.policy, graph.bitmapLoadState);
    const bitmapSurfaceSlots = definitions
      .filter(({primary, secondary}) => primary === 0x90 && secondary <= 0x1f)
      .map(({secondary}) => secondary);
    for (const secondary of [
      0x07, 0x0b, 0x10, 0x11, 0x12, 0x13, 0x14, 0x16, 0x17, 0x18, 0x1e, 0x1f,
    ])
      assert.ok(bitmapSurfaceSlots.includes(secondary));
    assert.equal(bitmapSurfaceSlots.includes(0x0d), false);
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x92 && [0x14, 0x15].includes(secondary))
        .map(({secondary}) => secondary),
      [0x14, 0x15],
    );

    const image = packedRgba(2, 1, [0xff112233, 0xff445566], [7, 9]);
    await graph.resource.files.write(encode('C:\\game\\picture.bg'), image);
    memory.globalMemory.set(new TextEncoder().encode('picture.bg\0'), 0x140);
    graph.resource.loading.cache.configure(1024);
    assert.equal(await invoke(0x92, 0x14, [0, 0x140], 2), 0);
    assert.equal(await child.pollProcess(false), 0);
    assert.equal(graph.resource.loading.hasPending, true);
    assert.equal(await graph.resource.loading.processNext(), true);
    assert.equal(await child.pollProcess(false), 1);
    assert.equal(child.process, null);
    assert.equal(
      graph.resource.loading.preloaded.size(null, new TextEncoder().encode('picture.bg')),
      image.length,
    );
    assert.equal(await invoke(0x90, 0x10, [2, 0, 0x140], 0), 0);
    assert.equal(
      graph.resource.loading.preloaded.size(null, new TextEncoder().encode('picture.bg')),
      null,
    );
    assert.equal(graph.resource.loading.activeProcedures, 0);
    assert.equal(graph.resource.loading.hasPending, false);
    const loaded = graph.surfaces.snapshot(2);
    assert.ok(loaded);
    assert.deepEqual(bitmapPixels(loaded), [0xff112233, 0xff445566]);
    assert.deepEqual(
      [graph.surfaces.record(2).metadataX, graph.surfaces.record(2).metadataY],
      [7, 9],
    );

    const directImage = packedRgba(1, 1, [0xffa1b2c3], [11, 13]);
    await graph.resource.files.write(encode('C:\\game\\direct.bg'), directImage);
    memory.globalMemory.set(new TextEncoder().encode('direct.bg\0'), 0x160);
    assert.equal(await invoke(0x90, 0x10, [4, 0, 0x160], 2), 0);
    assert.equal(await child.pollProcess(false), 0);
    assert.equal(await graph.resource.loading.processNext(), true);
    assert.equal(await child.pollProcess(false), 1);
    assert.equal(child.process, null);
    assert.deepEqual(bitmapPixels(graph.surfaces.snapshot(4)), [0xffa1b2c3]);
    assert.deepEqual(
      [graph.surfaces.record(4).metadataX, graph.surfaces.record(4).metadataY],
      [11, 13],
    );
    assert.equal(graph.resource.loading.activeProcedures, 0);
    assert.equal(graph.resource.loading.hasPending, false);

    assert.equal(await invoke(0x90, 0x16, [0x200, 2], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.deepEqual(
      Array.from(new Uint32Array(memory.globalMemory.buffer, 0x200, 6)),
      [0, 8, 2, 1, 2, 4],
    );
    assert.equal(await invoke(0x90, 0x11, [3, 2, 1, 2], 0), 0);
    assert.equal(await invoke(0x90, 0x13, [3, 0xff000000], 0), 0);
    assert.equal(await invoke(0x90, 0x1e, [3, 0, 0, 2, 0, 0, 2, 1], 0), 0);
    assert.deepEqual(bitmapPixels(graph.surfaces.snapshot(3)), [0xff112233, 0xff445566]);
    assert.equal(await invoke(0x90, 0x17, [3, 1], 0), 1);
    assert.equal(pop32(child.state), 0);
    assert.equal(graph.surfaces.snapshot(3).format, 1);

    const preservedImageId = graph.surfaces.imageId(3);
    assert.equal(await invoke(0x90, 0x0b, [1], 0), 0);
    assert.equal(graph.surfaces.preserveImageIds, 1);
    assert.equal(await invoke(0x90, 0x11, [3, 2, 1, 2], 0), 0);
    assert.equal(graph.surfaces.imageId(3), preservedImageId);
    assert.equal(await invoke(0x90, 0x18, [3, 0, 0, 2, 0x80, 0], 0), 0);
    assert.deepEqual(bitmapPixels(graph.surfaces.snapshot(3)), [0xff112233, 0xff445566]);
    assert.equal(await invoke(0x90, 0x0b, [0], 0), 0);
    assert.equal(graph.surfaces.preserveImageIds, 0);

    memory.globalMemory.set([1, 2, 3, 4, 5, 6], 0x240);
    assert.equal(await invoke(0x90, 0x14, [5, 2, 1, 1, 0x240], 0), 0);
    assert.deepEqual(bitmapPixels(graph.surfaces.snapshot(5)), [0x030201, 0x060504]);
    assert.deepEqual(
      [graph.surfaces.record(5).metadataX, graph.surfaces.record(5).metadataY],
      [-1, -1],
    );
    assert.equal(await invoke(0x90, 0x1f, [0x80000006, 5, 1, 0, 2, 1], 0), 0);
    assert.deepEqual(bitmapPixels(graph.surfaces.snapshot(6)), [0x060504, 0]);
    assert.deepEqual(
      [graph.surfaces.record(6).metadataX, graph.surfaces.record(6).metadataY],
      [-1, -1],
    );
    assert.equal(child.state.stackIndex, 0);

    graph.resource.loading.preloaded.insert(null, new TextEncoder().encode('spare'), image);
    assert.equal(await invoke(0x92, 0x15, [], 0), 0);
    assert.equal(
      graph.resource.loading.preloaded.size(null, new TextEncoder().encode('spare')),
      null,
    );
    assert.equal(await invoke(0x90, 0x07, [40], 0), 0);
    assert.equal(graph.bitmapLoadState.delay, 40);
    for (const index of [6, 5, 4, 3, 2]) {
      assert.equal(await invoke(0x90, 0x12, [index], 0), 1);
      assert.equal(pop32(child.state), 1);
    }
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});

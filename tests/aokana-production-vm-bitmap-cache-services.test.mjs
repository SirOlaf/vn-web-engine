import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

const pixels = (bitmap) =>
  Array.from({length: bitmap.width * bitmap.height}, (_, index) =>
    bitmap.storage.view.getUint32(
      bitmap.offset + Math.floor(index / bitmap.width) * bitmap.stride + (index % bitmap.width) * 4,
      true,
    ),
  );

test('mounted VM bitmap cache services share files, preload, cache, and surface owners', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, memory, child, definitions, fragments, encode, invoke} = fixture;
  const name = new TextEncoder().encode('cached-pixels\0');
  try {
    assert.equal(graph.bitmapCacheServices.loading, graph.bitmapLoading);
    assert.equal(graph.bitmapCacheServices.registration, graph.bitmapRegistration);
    assert.equal(graph.bitmapLoading.resources, graph.resource.loading);
    assert.equal(graph.bitmapRegistration.loading, graph.resource.loading);
    assert.equal(graph.bitmapRegistration.surfaces, graph.surfaces);
    assert.equal(graph.resource.loading.ranges.resources, graph.resource.resources);
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) =>
            primary === 0x90 && [0xc0, 0xc1, 0xc6, 0xc7].includes(secondary),
        )
        .map(({secondary}) => secondary),
      [0xc0, 0xc1, 0xc6, 0xc7],
    );
    assert.equal(fragments.nativeDefinitions().length, definitions.length);
    const raw = new Uint8Array(48);
    const rawHeader = new DataView(raw.buffer);
    rawHeader.setUint16(0, 2, true);
    rawHeader.setUint16(2, 2, true);
    rawHeader.setUint16(4, 24, true);
    rawHeader.setUint16(10, 1, true);
    rawHeader.setUint16(12, 3, true);
    rawHeader.setUint16(14, 4, true);
    const compressed = new Uint8Array(48);
    const compressedHeader = new DataView(compressed.buffer);
    compressed.set(new TextEncoder().encode('CompressedBG___\0'));
    compressedHeader.setUint16(16, 3, true);
    compressedHeader.setUint16(18, 1, true);
    compressedHeader.setUint16(20, 32, true);
    compressedHeader.setUint16(26, 1, true);
    compressedHeader.setUint16(28, 5, true);
    compressedHeader.setUint16(30, 6, true);
    await graph.resource.files.write(encode('C:\\game\\raw.bg'), raw);
    await graph.resource.files.write(encode('C:\\game\\compressed.bg'), compressed);
    memory.globalMemory.set(new TextEncoder().encode('raw.bg\0'), 0x100);
    memory.globalMemory.set(new TextEncoder().encode('compressed.bg\0'), 0x120);
    memory.globalMemory.set(new TextEncoder().encode(' raw.bg ,0,0 / compressed.bg \0'), 0x150);
    memory.globalMemory.set(name, 0x1a0);
    memory.globalMemory.set(new TextEncoder().encode('unchanged\0'), 0x1d0);
    const packed = Uint8Array.from([
      2, 0, 1, 0, 32, 0, 0, 0, 0, 0, 1, 0, 7, 0, 9, 0, 51, 34, 17, 255, 102, 85, 68, 255,
    ]);
    memory.globalMemory.set(packed, 0x200);
    const call = async (secondary, args, pushed = false) => {
      assert.equal(await invoke(0x90, secondary, args, 0), Number(pushed));
      const result = pushed ? pop32(child.state) : undefined;
      assert.equal(child.state.stackIndex, 0);
      return result;
    };
    assert.equal(await call(0x03, [1024]), undefined);
    assert.equal(graph.resource.loading.cache.capacity, 1024);
    await call(0xc0, [0, 0, 0x100]);
    await call(0xc0, [1, 0, 0x120]);
    assert.deepEqual(
      [
        graph.surfaces.snapshot(0).width,
        graph.surfaces.snapshot(0).height,
        graph.surfaces.snapshot(0).format,
      ],
      [2, 2, 1],
    );
    assert.deepEqual(
      [
        graph.surfaces.snapshot(1).width,
        graph.surfaces.snapshot(1).height,
        graph.surfaces.snapshot(1).format,
      ],
      [3, 1, 2],
    );
    assert.deepEqual(pixels(graph.surfaces.snapshot(0)), [0, 0, 0, 0]);
    assert.deepEqual(pixels(graph.surfaces.snapshot(1)), [0, 0, 0]);
    assert.deepEqual(
      [graph.surfaces.record(0).metadataX, graph.surfaces.record(0).metadataY],
      [3, 4],
    );
    assert.deepEqual(
      [graph.surfaces.record(1).metadataX, graph.surfaces.record(1).metadataY],
      [5, 6],
    );

    assert.equal(await call(0xc1, [0x1d0, 0, 0x150], true), 1);
    assert.equal(
      new TextDecoder().decode(memory.globalMemory.subarray(0x1d0, 0x1d0 + 10)),
      'unchanged\0',
    );
    assert.equal(await call(0xc6, [0, 0x1a0, 0x200, packed.length], true), 1);
    assert.equal(graph.resource.loading.preloaded.size(null, name), packed.length);
    assert.equal(graph.resource.loading.cache.read(null, name), null);
    assert.equal(await call(0xc7, [2, 0, 0x1a0, 1], true), 1);
    assert.deepEqual(pixels(graph.surfaces.snapshot(2)), [0xff112233, 0xff445566]);
    assert.deepEqual(
      [graph.surfaces.record(2).metadataX, graph.surfaces.record(2).metadataY],
      [7, 9],
    );
    assert.equal(graph.resource.loading.preloaded.size(null, name), null);
    assert.deepEqual(graph.resource.loading.cache.read(null, name), packed);
    assert.equal(await call(0xc7, [3, 0, 0x1a0, 1], true), 1);
    assert.deepEqual(pixels(graph.surfaces.snapshot(3)), [0xff112233, 0xff445566]);
    assert.deepEqual(
      [graph.surfaces.record(3).metadataX, graph.surfaces.record(3).metadataY],
      [7, 9],
    );
    assert.deepEqual(graph.resource.loading.cache.read(null, name), packed);
    assert.deepEqual(memory.globalMemory.subarray(0x200, 0x200 + packed.length), packed);
    for (const index of [3, 2, 1, 0]) assert.equal(await call(0x12, [index], true), 1);
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});

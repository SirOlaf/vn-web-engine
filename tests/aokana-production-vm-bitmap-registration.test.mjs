import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

function bitmapPixels(bitmap) {
  return Array.from({length: bitmap.width * bitmap.height}, (_, index) =>
    bitmap.storage.view.getUint32(
      bitmap.offset + Math.floor(index / bitmap.width) * bitmap.stride + (index % bitmap.width) * 4,
      true,
    ),
  );
}

test('mounted VM registers packed bitmap cache and decoded preload through one codec owner', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, memory, child, definitions, fragments, invoke} = fixture;
  try {
    assert.equal(graph.bitmapRegistration.loading, graph.resource.loading);
    assert.equal(graph.bitmapRegistration.surfaces, graph.surfaces);
    assert.equal(graph.codecWorkers.readSystemTime().getUTCMilliseconds(), 0);
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x91 && [0x03, 0x04].includes(secondary))
        .map(({secondary}) => secondary),
      [0x03, 0x04],
    );
    assert.equal(fragments.nativeDefinitions().length, definitions.length);
    assert.equal(await invoke(0x90, 0x03, [1024], 0), 0);
    const packed = Uint8Array.from([
      2, 0, 1, 0, 32, 0, 0, 0, 0, 0, 1, 0, 7, 0, 9, 0, 51, 34, 17, 255, 102, 85, 68, 255,
    ]);
    const cacheName = new TextEncoder().encode('cached-image\0');
    const preloadName = new TextEncoder().encode('preloaded-image\0');
    memory.globalMemory.set(cacheName, 0x140);
    memory.globalMemory.set(preloadName, 0x160);
    memory.globalMemory.set(packed, 0x200);
    assert.equal(await invoke(0x91, 0x03, [0, 0x140, 0x200, packed.length], 0), 1);
    assert.equal(pop32(child.state), 0);
    assert.equal(child.state.stackIndex, 0);
    assert.deepEqual(graph.resource.loading.cache.read(null, cacheName), packed);
    assert.equal(await invoke(0x90, 0x10, [1, 0, 0x140], 0), 0);
    assert.deepEqual(bitmapPixels(graph.surfaces.snapshot(1)), [0xff112233, 0xff445566]);
    assert.deepEqual(
      [graph.surfaces.record(1).metadataX, graph.surfaces.record(1).metadataY],
      [7, 9],
    );

    // Literal-only SDC: one token for the twenty-four packed bitmap bytes.
    const encoded = new Uint8Array(57);
    const header = new DataView(encoded.buffer);
    encoded.set(new TextEncoder().encode('SDC FORMAT 1.00\0'));
    header.setUint32(20, 25, true);
    header.setUint32(24, 24, true);
    header.setUint16(28, 3205, true);
    header.setUint16(30, 151, true);
    encoded.set(
      [
        23, 92, 130, 231, 66, 168, 205, 187, 15, 164, 150, 45, 222, 250, 95, 69, 80, 87, 131, 208,
        214, 85, 38, 90, 160,
      ],
      32,
    );
    memory.globalMemory.set(encoded, 0x300);
    assert.equal(await invoke(0x91, 0x04, [2, 0x300, encoded.length, 0, 0x160, 1], 2), 0);
    assert.equal(graph.resource.loading.activeProcedures, 1);
    assert.equal(await child.pollProcess(false), 0);
    await graph.codecWorkers.joinPending();
    assert.equal(graph.codecWorkers.hasPendingWork(), false);
    assert.equal(await child.pollProcess(false), 1);
    assert.equal(child.process, null);
    assert.equal(graph.resource.loading.activeProcedures, 0);
    assert.equal(pop32(child.state), 0);
    assert.deepEqual(bitmapPixels(graph.surfaces.snapshot(2)), [0xff112233, 0xff445566]);
    assert.equal(graph.resource.loading.preloaded.size(null, preloadName), packed.length);
    assert.equal(await invoke(0x90, 0x10, [3, 0, 0x160], 0), 0);
    assert.equal(graph.resource.loading.preloaded.size(null, preloadName), null);
    assert.deepEqual(bitmapPixels(graph.surfaces.snapshot(3)), [0xff112233, 0xff445566]);
    assert.deepEqual(
      [graph.surfaces.record(3).metadataX, graph.surfaces.record(3).metadataY],
      [7, 9],
    );
    assert.deepEqual(memory.globalMemory.subarray(0x300, 0x300 + encoded.length), encoded);
    assert.equal(child.state.stackIndex, 0);
    for (const index of [3, 2, 1]) {
      assert.equal(await invoke(0x90, 0x12, [index], 0), 1);
      assert.equal(pop32(child.state), 1);
    }
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});

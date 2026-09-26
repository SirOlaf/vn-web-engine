import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {decodeCompressedBgLegacy} from '../dist/formats/buriko/compressed-bg.js';
import {decodeBurikoCompressedBgV2} from '../dist/engines/buriko/native/compressed-bg-v2.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM raw-exports and compresses graph surfaces into BP output buffers', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, memory, child, definitions, fragments, invoke} = fixture;
  try {
    assert.equal(graph.compressedSurfaceEncoder.surfaces, graph.surfaces);
    assert.equal(graph.compressedSurfaceEncoder.raw.surfaces, graph.surfaces);
    assert.equal(graph.compressedSurfaceEncoder.processing, graph.resource.processing);
    assert.equal(graph.compressedSurfaceEncoder.ticks, graph.ticks);
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x90 && [0x15, 0xce].includes(secondary))
        .map(({secondary}) => secondary),
      [0x15, 0xce],
    );
    assert.equal(fragments.nativeDefinitions().length, definitions.length);
    assert.ok(memory.globalMemory.length >= 0x10000);
    const view = new DataView(memory.globalMemory.buffer);
    const original = Array.from(
      {length: 64},
      (_, index) => (index + 1) | ((2 * (index + 1)) << 8) | ((3 * (index + 1)) << 16),
    );
    const bgr = Uint8Array.from(
      original.flatMap((pixel) => [pixel & 255, (pixel >>> 8) & 255, (pixel >>> 16) & 255]),
    );
    memory.globalMemory.set(bgr, 0x400);
    assert.equal(await invoke(0x90, 0x14, [0, 64, 1, 1, 0x400], 0), 0);
    assert.deepEqual(
      Array.from({length: 64}, (_, index) =>
        graph.surfaces.snapshot(0).storage.view.getUint32(index * 4, true),
      ),
      original,
    );
    memory.globalMemory.fill(0xa5, 0x800, 0x900);
    assert.equal(await invoke(0x90, 0x15, [0x800, 0x280, 256, 0], 0), 0);
    assert.equal(view.getUint32(0x280, true), bgr.length);
    assert.deepEqual(memory.globalMemory.subarray(0x800, 0x800 + bgr.length), bgr);
    assert.equal(memory.globalMemory[0x800 + bgr.length], 0xa5);
    assert.equal(child.state.stackIndex, 0);

    // 90:CE publishes the count after synchronously encoding into ample BP space.
    memory.globalMemory.fill(0x5a, 0x1000, 0x4000);
    assert.equal(await invoke(0x90, 0xce, [0x1000, 0x284, 0, 0, 75], 0), 0);
    const legacyLength = view.getUint32(0x284, true);
    assert.ok(legacyLength > 48 && legacyLength < 0x3000);
    const legacy = memory.globalMemory.subarray(0x1000, 0x1000 + legacyLength);
    const restored = decodeCompressedBgLegacy(legacy);
    assert.deepEqual([restored.width, restored.height, restored.bitDepth], [64, 1, 32]);
    assert.deepEqual(
      restored.pixels,
      Uint8Array.from(
        original.flatMap((pixel) => [pixel & 255, (pixel >>> 8) & 255, (pixel >>> 16) & 255, 0]),
      ),
    );
    assert.equal(memory.globalMemory[0x1000 + legacyLength], 0x5a);
    assert.equal(graph.resource.processing.distributedFlag, 0);
    assert.equal(child.state.stackIndex, 0);

    memory.globalMemory.fill(0x40, 0x4000, 0x5000);
    const modernInput = new DataView(memory.globalMemory.buffer);
    for (let index = 0; index < 64 * 16; index++)
      modernInput.setUint32(0x4000 + index * 4, 0x80404040, true);
    assert.equal(await invoke(0x90, 0x14, [1, 64, 16, 2, 0x4000], 0), 0);
    memory.globalMemory.fill(0x7b, 0x6000, 0xf000);
    assert.equal(await invoke(0x90, 0xce, [0x6000, 0x288, 1, 1, 75], 0), 0);
    const modernLength = view.getUint32(0x288, true);
    assert.ok(modernLength > 48 && modernLength < 0x9000);
    const modern = memory.globalMemory.subarray(0x6000, 0x6000 + modernLength);
    const decoded = await decodeBurikoCompressedBgV2(modern, graph.resource.processing);
    assert.equal(decoded.initializedLength, 16 + 64 * 16 * 4);
    const expectedPixels = new Uint8Array(64 * 16 * 4);
    for (let index = 0; index < 64 * 16; index++)
      new DataView(expectedPixels.buffer).setUint32(index * 4, 0x80404040, true);
    assert.deepEqual(decoded.bytes.subarray(16), expectedPixels);
    assert.equal(memory.globalMemory[0x6000 + modernLength], 0x7b);
    assert.equal(graph.resource.processing.distributedFlag, 0);
    assert.equal(child.state.stackIndex, 0);
    for (const index of [1, 0]) {
      assert.equal(await invoke(0x90, 0x12, [index], 0), 1);
      assert.equal(pop32(child.state), 1);
    }
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});

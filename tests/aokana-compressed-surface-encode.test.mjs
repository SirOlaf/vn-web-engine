import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {bitmapRead32, bitmapWrite32} from '../dist/engines/buriko/native/bitmap-scalar.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoSystemTicks} from '../dist/engines/buriko/native/system-ticks.js';
import {BurikoCompressedSurfaceEncoder} from '../dist/engines/buriko/native/surface-compressed-encode.js';
import {createGroup90CompressedEncode} from '../dist/engines/buriko/native/group-90-compressed-encode.js';
import {decodeCompressedBgLegacy} from '../dist/formats/buriko/compressed-bg.js';
import {decodeBurikoCompressedBgV2} from '../dist/engines/buriko/native/compressed-bg-v2.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';

test('90:CE exports both real surface formats through complete encoders and imports decoded pixels', async () => {
  const allocator = new BurikoDistributedAllocator(2),
    processing = new BurikoDistributedProcessing(allocator, 2),
    surfaces = new BurikoSurfaces(
      new BurikoNativeFonts(new BurikoNativeText()),
      new BurikoBitmapCompositor(),
      allocator,
    ),
    encoder = new BurikoCompressedSurfaceEncoder(
      surfaces,
      processing,
      new BurikoSystemTicks({now: () => 1234}),
    ),
    [slot] = createGroup90CompressedEncode(encoder, {
      threadFatal() {
        assert.fail('ordinary complete surface encoding');
      },
    }),
    memory = new BurikoBpMemory(new Uint8Array(20000)),
    thread = new BurikoBpThread({id: 1, operandCapacity: 16, moduleCapacity: 0, frameCapacity: 0}),
    view = new DataView(memory.globalMemory.buffer);
  assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x90][0xce]);
  for (const mode of [0, 1]) {
    const height = mode === 0 ? 1 : 16,
      format = mode === 0 ? 1 : 2;
    assert.equal(surfaces.allocate(mode, 64, height, format), 1);
    const source = surfaces.snapshot(mode),
      expected = [];
    for (let y = 0; y < height; y++)
      for (let x = 0; x < 64; x++) {
        const pixel =
          mode === 0 ? (x + 1) | ((2 * (x + 1)) << 8) | ((3 * (x + 1)) << 16) : 0x80404040 >>> 0;
        expected.push(pixel);
        bitmapWrite32(source, source.offset + y * source.stride + x * 4, pixel);
      }
    [64, 32, mode, mode, 75].forEach((value) => push32(thread, value));
    assert.equal(slot.execute({thread, memory, diagnostics: {}}), 0);
    assert.equal(thread.stackIndex, 0);
    const length = view.getUint32(32, true),
      encoded = memory.globalMemory.subarray(64, 64 + length);
    let pixels;
    if (mode === 0) {
      assert.equal(length, 353);
      pixels = decodeCompressedBgLegacy(encoded).pixels;
    } else {
      const decoded = await decodeBurikoCompressedBgV2(encoded, processing);
      assert.equal(decoded.initializedLength, 16 + 64 * height * 4);
      pixels = decoded.bytes.subarray(16);
    }
    assert.equal(surfaces.importRaw(2, 64, height, 2, {bytes: pixels, offset: 0}), 1);
    const restored = surfaces.snapshot(2);
    assert.deepEqual(
      expected.map((_, i) =>
        bitmapRead32(
          restored,
          restored.offset + Math.floor(i / 64) * restored.stride + (i % 64) * 4,
        ),
      ),
      expected,
    );
  }
});

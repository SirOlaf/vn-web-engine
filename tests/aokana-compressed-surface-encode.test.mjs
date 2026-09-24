import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {
  bitmapRead32,
  bitmapWrite32,
} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaSystemTicks} from '../dist/engines/buriko/games/aokana/native/system-ticks.js';
import {AokanaCompressedSurfaceEncoder} from '../dist/engines/buriko/games/aokana/native/surface-compressed-encode.js';
import {createGroup90CompressedEncode} from '../dist/engines/buriko/games/aokana/native/group-90-compressed-encode.js';
import {decodeCompressedBgLegacy} from '../dist/formats/buriko/compressed-bg.js';
import {decodeAokanaCompressedBgV2} from '../dist/engines/buriko/games/aokana/native/compressed-bg-v2.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';

test('90:CE exports both real surface formats through complete encoders and imports decoded pixels', async () => {
  const allocator = new AokanaDistributedAllocator(2),
    processing = new AokanaDistributedProcessing(allocator, 2),
    surfaces = new AokanaSurfaces(
      new AokanaNativeFonts(new AokanaNativeText()),
      new AokanaBitmapCompositor(),
      allocator,
    ),
    encoder = new AokanaCompressedSurfaceEncoder(
      surfaces,
      processing,
      new AokanaSystemTicks({now: () => 1234}),
    ),
    [slot] = createGroup90CompressedEncode(encoder, {
      threadFatal() {
        assert.fail('ordinary complete surface encoding');
      },
    }),
    memory = new AokanaBpMemory(new Uint8Array(20000)),
    thread = new AokanaBpThread({id: 1, operandCapacity: 16, moduleCapacity: 0, frameCapacity: 0}),
    view = new DataView(memory.globalMemory.buffer);
  assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x90][0xce]);
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
      const decoded = await decodeAokanaCompressedBgV2(encoded, processing);
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

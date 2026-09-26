import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBitmapStorage} from '../dist/engines/buriko/native/bitmap.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoSystemTicks} from '../dist/engines/buriko/native/system-ticks.js';
import {encodeBurikoCompressedBgV2} from '../dist/engines/buriko/native/compressed-bg-modern-encode.js';
import {decodeBurikoCompressedBgV2} from '../dist/engines/buriko/native/compressed-bg-v2.js';
import {randomByteGenerator} from '../dist/formats/buriko/binary.js';

// Gray128 at quality25 produces zero coefficients; gray64 at quality75 also
// exercises nonzero luminance DC categories. Width64 yields24 component blocks
// per row band: the24-bit AC stream initializes its next private lookahead byte.
test('modern BG encoder emits RGB streams and decodes RGBA with real worker passes', async () => {
  const width = 64,
    height = 16;
  const allocator = new BurikoDistributedAllocator(2),
    processing = new BurikoDistributedProcessing(allocator, 2);
  const ticks = new BurikoSystemTicks({now: () => 1234});
  for (const depth of [24, 32])
    for (const quality of [25, 75]) {
      const channels = depth >>> 3,
        raw = new Uint8Array(16 + width * height * channels),
        header = new DataView(raw.buffer);
      header.setUint16(0, width, true);
      header.setUint16(2, height, true);
      header.setUint16(4, depth, true);
      header.setUint16(8, depth === 24 ? 1 : 2, true);
      const color = quality === 25 ? 128 : 64;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const at = 16 + (y * width + x) * channels;
          raw.set([color, color, color], at);
          if (channels === 4) raw[at + 3] = 64 + (x % 32) * 4;
        }
      const output = new BurikoBitmapStorage(
        new Uint8Array(width * height * channels * 4 + 48),
        false,
      );
      const result = encodeBurikoCompressedBgV2(raw, output, quality, processing, ticks);
      assert.equal(result.status, 0);
      output.range(0, result.length, true);
      const encoded = output.bytes.subarray(0, result.length),
        view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
      assert.equal(view.getUint32(36, true), 1234);
      assert.equal(view.getUint32(40, true), 132);
      assert.equal(view.getUint16(46, true), 2);
      // Native luminance DC quantizer: floor(255-(255-16)*.5)=135;
      // upper-quality branch floor(16*.5)=8.
      assert.equal((encoded[48] - randomByteGenerator(1234)()) & 255, quality === 25 ? 135 : 8);
      if (depth === 24) {
        // Native RGB stores two offsets, without an alpha/sentinel entry.
        // Q25:24 zero-DC and24 EOB codes. Q75: YDC=-64, other DC0,
        // so categories7 at blocks0/8 and0 elsewhere. Native tree codes are
        // category7→0, category0→1; amplitudes0111111 and1000000 give
        // literal DC bytes3F FE81 FF FC. AC remains24 zero bits.
        const frequencies = new Uint8Array(192);
        frequencies[0] = quality === 25 ? 48 : 44;
        if (quality === 75) frequencies[7] = 4;
        frequencies[16] = 48;
        const offsets = Uint8Array.of(200, 0, 0, 0, quality === 25 ? 209 : 211, 0, 0, 0);
        const row =
          quality === 25
            ? Uint8Array.of(255, 128, 12, 0, 0, 0, 0, 0, 0)
            : Uint8Array.of(255, 128, 12, 0x3f, 0xfe, 0x81, 0xff, 0xfc, 0, 0, 0);
        assert.deepEqual(
          encoded.subarray(180),
          Uint8Array.from([...frequencies, ...offsets, ...row, ...row]),
        );
        continue;
      }
      const decoded = await decodeBurikoCompressedBgV2(encoded, processing);
      assert.deepEqual(decoded.bytes.subarray(0, 16), raw.subarray(0, 16));
      const written = 16 + width * height * channels;
      assert.equal(decoded.initializedLength, written);
      assert.deepEqual(decoded.initialized.subarray(0, written), new Uint8Array(written).fill(1));
      assert.deepEqual(decoded.bytes.subarray(16, written), raw.subarray(16));
    }
});

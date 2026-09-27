import {requireBurikoResourceRange as checkRange} from './bf-entropy.js';
import {BurikoUndefinedResourceRead, BurikoResourceCodecException} from './resource-memory.js';
import {randomByteGenerator, signature} from '../../../formats/buriko/binary.js';
import {type BurikoBfSurface, decodeBurikoBfFrameAsync} from './bf-frame.js';
import type {BurikoDistributedProcessing} from './distributed-processing.js';
import {HostTaskBudget} from '../../../core/host-task-budget.js';

export interface BurikoDecodedImageResource {
  readonly bytes: Uint8Array;
  /** Version2 depth24 reports a larger allocation than the prefix its crop loop writes. */
  readonly initializedLength: number;
  readonly initialized: Uint8Array;
}

/** 0x140109bd0's image wrapper around the existing native BF_Movie codec. */
export async function decodeBurikoCompressedBgV2(
  input: Uint8Array,
  processing: BurikoDistributedProcessing,
  destination?: BurikoBfSurface,
  actor = processing.allocator.currentActor,
  beforeResume?: () => void,
): Promise<BurikoDecodedImageResource> {
  beforeResume?.();
  checkRange(input.length, 0, 48);
  const data = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (!signature(input, 'CompressedBG___\0') || data.getUint16(46, true) !== 2) {
    throw new Error('Not Buriko CompressedBG version2');
  }
  const width = data.getUint16(16, true),
    height = data.getUint16(18, true),
    depth = data.getUint16(20, true);
  const paddedWidth = (width + 7) & ~7,
    paddedHeight = (height + 7) & ~7;
  const copiedChannels = depth >>> 3;
  if (width === 0 || height === 0 || copiedChannels > 4) {
    throw new BurikoUndefinedResourceRead(
      'Buriko CompressedBG geometry would access undefined native storage',
    );
  }
  const tableLength = data.getUint32(40, true);
  checkRange(input.length, 48, tableLength);
  const table = input.slice(48, 48 + tableLength);
  const nextByte = randomByteGenerator(data.getUint32(36, true));
  let sum = 0,
    xor = 0;
  for (let index = 0; index < table.length; index++) {
    const byte = (table[index]! - nextByte()) & 255;
    table[index] = byte;
    sum = (sum + byte) & 255;
    xor ^= byte;
  }
  if (sum !== input[44] || xor !== input[45])
    throw new BurikoResourceCodecException(
      3,
      'Buriko CompressedBG version2 table checksum mismatch',
    );
  const reportedChannels = depth === 24 ? 4 : copiedChannels;
  const extent = 16 + width * height * reportedChannels;
  const result = destination?.bytes.subarray(0, extent) ?? new Uint8Array(extent);
  const initialized = destination?.initialized.subarray(0, extent) ?? new Uint8Array(extent);
  checkRange(result.length, 0, extent);
  checkRange(initialized.length, 0, extent);
  // 109BD0 publishes the header before invoking any frame decoder work.
  result.set(input.subarray(16, 32));
  initialized.fill(1, 0, 16);
  checkRange(table.length, 0, 128);
  const frame = input.subarray(48 + tableLength);
  if (width === paddedWidth && height === paddedHeight && depth === 32) {
    await decodeBurikoBfFrameAsync(
      frame,
      width,
      height,
      depth,
      table.subarray(0, 128),
      processing,
      {
        bytes: result.subarray(16),
        initialized: initialized.subarray(16),
      },
      undefined,
      actor,
      beforeResume,
    );
    beforeResume?.();
    return {bytes: result, initializedLength: extent, initialized};
  }
  const decodedPixels = await decodeBurikoBfFrameAsync(
    frame,
    paddedWidth,
    paddedHeight,
    depth,
    table.subarray(0, 128),
    processing,
    undefined,
    undefined,
    actor,
    beforeResume,
  );
  beforeResume?.();
  let written = 16,
    copiedPixelCount = 0;
  const budget = new HostTaskBudget();
  for (let y = 0; y < height; y++) {
    if (copiedChannels === 4) {
      const start = y * paddedWidth * 4;
      const end = start + width * 4;
      result.set(decodedPixels.bytes.subarray(start, end), written);
      initialized.set(decodedPixels.initialized.subarray(start, end), written);
      written += width * 4;
      const pending = budget.checkpoint();
      if (pending !== undefined) {
        await pending;
        beforeResume?.();
      }
      continue;
    }
    for (let x = 0; x < width; x++) {
      const pixel = (y * paddedWidth + x) * 4;
      // Crop into packed native channels without allocating two views per pixel.
      for (let channel = 0; channel < copiedChannels; channel++, written++) {
        result[written] = decodedPixels.bytes[pixel + channel]!;
        initialized[written] = decodedPixels.initialized[pixel + channel]!;
      }
      if ((++copiedPixelCount & 255) === 0) {
        const pending = budget.checkpoint();
        if (pending !== undefined) {
          await pending;
          beforeResume?.();
        }
      }
    }
  }
  return {bytes: result, initializedLength: written, initialized};
}

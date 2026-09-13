import {requireAokanaResourceRange as checkRange} from './bf-entropy.js';
import {AokanaUndefinedResourceRead, AokanaResourceCodecException} from './resource-memory.js';
import {randomByteGenerator, signature} from '../../../../../formats/buriko/binary.js';
import {decodeAokanaBfFrame} from './bf-frame.js';
import type {AokanaDistributedProcessing} from './distributed-processing.js';

export interface AokanaDecodedImageResource {
  readonly bytes: Uint8Array;
  /** Version2 depth24 reports a larger allocation than the prefix its crop loop writes. */
  readonly initializedLength: number;
  readonly initialized: Uint8Array;
}

/** 0x140109bd0's image wrapper around the existing native BF_Movie codec. */
export async function decodeAokanaCompressedBgV2(input: Uint8Array, processing: AokanaDistributedProcessing): Promise<AokanaDecodedImageResource> {
  checkRange(input.length, 0, 48);
  const data = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (!signature(input, 'CompressedBG___\0') || data.getUint16(46, true) !== 2) {
    throw new Error('Not Aokana CompressedBG version2');
  }
  const width = data.getUint16(16, true), height = data.getUint16(18, true), depth = data.getUint16(20, true);
  const paddedWidth = (width + 7) & ~7, paddedHeight = (height + 7) & ~7;
  const copiedChannels = depth >>> 3;
  if (width === 0 || height === 0 || copiedChannels > 4) {
    throw new AokanaUndefinedResourceRead('Aokana CompressedBG geometry would access undefined native storage');
  }
  const tableLength = data.getUint32(40, true);
  checkRange(input.length, 48, tableLength);
  const table = input.slice(48, 48 + tableLength);
  const nextByte = randomByteGenerator(data.getUint32(36, true));
  let sum = 0, xor = 0;
  for (let index = 0; index < table.length; index++) {
    const byte = (table[index]! - nextByte()) & 255;
    table[index] = byte;
    sum = (sum + byte) & 255;
    xor ^= byte;
  }
  if (sum !== input[44] || xor !== input[45]) throw new AokanaResourceCodecException(3, 'Aokana CompressedBG version2 table checksum mismatch');
  checkRange(table.length, 0, 128);
  const frame = input.subarray(48 + tableLength);
  const pixels = decodeAokanaBfFrame(frame, paddedWidth, paddedHeight, depth, table.subarray(0, 128), processing);
  const reportedChannels = depth === 24 ? 4 : copiedChannels;
  const result = new Uint8Array(16 + width * height * reportedChannels);
  const initialized = new Uint8Array(result.length);
  initialized.fill(1, 0, 16);
  result.set(input.subarray(16, 32));
  let written = 16;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = (y * paddedWidth + x) * 4;
      result.set(pixels.bytes.subarray(pixel, pixel + copiedChannels), written);
      initialized.set(pixels.initialized.subarray(pixel, pixel + copiedChannels), written);
      written += copiedChannels;
    }
  }
  return {bytes: result, initializedLength: written, initialized};
}

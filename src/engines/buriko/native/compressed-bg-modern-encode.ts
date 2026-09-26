import {BurikoBitmapStorage} from './bitmap.js';
import {requireBurikoResourceRange as checkRange} from './bf-entropy.js';
import {BurikoResourceCodecException, BurikoUndefinedResourceRead} from './resource-memory.js';
import type {BurikoDistributedProcessing} from './distributed-processing.js';
import type {BurikoSystemTicks} from './system-ticks.js';
import {randomByteGenerator} from '../../../formats/buriko/binary.js';
import {
  burikoBfEncoderQuantization,
  burikoBfEncoderComponents,
  burikoBfForwardBlock,
} from './bf-forward-transform.js';
import {
  burikoBfEncoderTrees,
  encodeBurikoBfCoefficientRow,
  encodeBurikoBfAlphaLz,
  burikoBfWriteBytes,
  burikoBfEncodedVarint,
} from './bf-encode-entropy.js';
import {decodeBurikoBfCoefficients, decodeBurikoBfAlphaLz} from './bf-frame.js';

type Result = {status: 0; length: number} | {status: 1 | 2 | 6 | 8 | 9};
function write32(storage: BurikoBitmapStorage, offset: number, value: number): void {
  storage.range(offset, 4, false);
  storage.view.setUint32(offset, value >>> 0, true);
  storage.written(offset, 4);
}
function jobs(
  processing: BurikoDistributedProcessing,
  count: number,
  callback: (index: number) => void,
): void {
  let next = 0;
  processing.setCallback(() => {
    const force = processing.enterShared();
    const index = next < count ? next++ : -1;
    processing.leaveShared(force);
    if (index < 0) return 0;
    callback(index);
    return 1;
  }, null);
  processing.run(1);
  processing.setCallback(null, null);
}

/** 109F30: modern image producer over actual fixed output storage and shared workers/ticks. */
export function encodeBurikoCompressedBgV2(
  input: Uint8Array,
  output: BurikoBitmapStorage,
  quality: number,
  processing: BurikoDistributedProcessing,
  ticks: BurikoSystemTicks,
): Result {
  const raw = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const word = (offset: number): number => {
    checkRange(input.length, offset, 2);
    return raw.getUint16(offset, true);
  };
  const width = word(0);
  if (width === 0) return {status: 1};
  const height = word(2);
  if (height === 0) return {status: 1};
  const depth = word(4);
  if (![8, 16, 24, 32, 48].includes(depth)) return {status: 1};
  if (word(8) >= 7) return {status: 1};
  if (depth !== 8 && depth !== 24 && depth !== 32) return {status: 2};
  const channels = depth >>> 3,
    components = channels === 4 ? 3 : channels,
    paddedWidth = (width + 7) & ~7,
    paddedHeight = (height + 7) & ~7,
    stride = paddedWidth * channels,
    columns = paddedWidth >>> 3,
    rows = paddedHeight >>> 3,
    maskSize = (columns + 7) >>> 3;
  const quantization = burikoBfEncoderQuantization(quality | 0);
  // 109A40 publishes the complete header before allocating/encoding image work.
  burikoBfWriteBytes(output, 0, new Uint8Array(16));
  burikoBfWriteBytes(output, 0, new TextEncoder().encode('CompressedBG___'));
  checkRange(input.length, 0, 16);
  const capturedHeader = input.slice(0, 16);
  write32(output, 32, 0);
  burikoBfWriteBytes(output, 16, capturedHeader);
  const seed = ticks.getTickCount();
  write32(output, 40, 132);
  write32(output, 36, seed);
  const table = new Uint8Array(132);
  table.set(quantization.bytes);
  new DataView(table.buffer).setUint32(128, 180, true);
  burikoBfWriteBytes(output, 48, table);
  let sum = 0,
    xor = 0;
  for (const byte of table) {
    sum = (sum + byte) & 255;
    xor ^= byte;
  }
  burikoBfWriteBytes(output, 44, Uint8Array.of(sum, xor, 2, 0));
  const random = randomByteGenerator(seed);
  for (let index = 0; index < table.length; index++)
    table[index] = (table[index]! + random()) & 255;
  burikoBfWriteBytes(output, 48, table);
  try {
    const pixels = new Uint8Array(stride * paddedHeight);
    for (let y = 0; y < height; y++) {
      checkRange(input.length, 16 + y * width * channels, width * channels);
      pixels.set(
        input.subarray(16 + y * width * channels, 16 + (y + 1) * width * channels),
        y * stride,
      );
    }
    const coefficientRows = Array.from(
      {length: rows},
      () => new Int16Array(paddedWidth * 8 * components),
    );
    let alpha: ReturnType<typeof encodeBurikoBfAlphaLz> | null = null;
    const skip = channels === 4 ? 1 : 0;
    jobs(processing, rows + skip, (index) => {
      if (index === 0 && skip !== 0) {
        alpha = encodeBurikoBfAlphaLz(pixels, paddedWidth, stride, paddedWidth * paddedHeight * 2);
        return;
      }
      const row = index - skip,
        coefficients = coefficientRows[row]!;
      for (let column = 0; column < columns; column++) {
        const planes = Array.from({length: components}, () => Array<number>(64));
        for (let y = 0; y < 8; y++)
          for (let x = 0; x < 8; x++) {
            const at = (row * 8 + y) * stride + (column * 8 + x) * channels;
            if (components === 1) planes[0]![y * 8 + x] = pixels[at]!;
            else {
              const values = burikoBfEncoderComponents(
                pixels[at]!,
                pixels[at + 1]!,
                pixels[at + 2]!,
              );
              for (let component = 0; component < 3; component++)
                planes[component]![y * 8 + x] = values[component]!;
            }
          }
        for (let component = 0; component < components; component++) {
          const start = component === 0 ? 0 : 64;
          coefficients.set(
            burikoBfForwardBlock(
              planes[component]!,
              quantization.multipliers.subarray(start, start + 64),
            ),
            component * columns * 64 + column * 64,
          );
        }
      }
    });
    const trees = burikoBfEncoderTrees(coefficientRows);
    const encodedRows: ReturnType<typeof encodeBurikoBfCoefficientRow>[] = [];
    jobs(processing, rows, (index) => {
      encodedRows[index] = encodeBurikoBfCoefficientRow(
        coefficientRows[index]!,
        trees.dc,
        trees.ac,
      );
    });
    let cursor = 180;
    for (const frequency of trees.frequencies) {
      const bytes = burikoBfEncodedVarint(frequency);
      burikoBfWriteBytes(output, cursor, bytes);
      cursor += bytes.length;
    }
    const offsets = cursor;
    cursor += (rows + skip) * 4;
    let planned = cursor;
    for (let row = 0; row < rows; row++) {
      write32(output, offsets + row * 4, planned - 180);
      planned +=
        maskSize +
        burikoBfEncodedVarint(coefficientRows[row]!.length).length +
        encodedRows[row]!.length;
    }
    if (skip !== 0) write32(output, offsets + rows * 4, planned - 180);
    for (let row = 0; row < rows; row++) {
      const mask = new Uint8Array(maskSize);
      for (let column = 0; column < columns; column++) mask[column >>> 3]! |= 1 << (column & 7);
      burikoBfWriteBytes(output, cursor, mask);
      cursor += mask.length;
      const count = burikoBfEncodedVarint(coefficientRows[row]!.length);
      burikoBfWriteBytes(output, cursor, count);
      cursor += count.length;
      const encoded = encodedRows[row]!;
      encoded.storage.range(0, encoded.length, true);
      burikoBfWriteBytes(output, cursor, encoded.storage.bytes.subarray(0, encoded.length));
      cursor += encoded.length;
    }
    if (skip !== 0) {
      if (alpha === null) throw new Error('Buriko alpha encoder job did not publish storage');
      const encoded = alpha as ReturnType<typeof encodeBurikoBfAlphaLz>;
      write32(output, cursor, 1);
      cursor += 4;
      encoded.storage.range(0, encoded.length, true);
      burikoBfWriteBytes(output, cursor, encoded.storage.bytes.subarray(0, encoded.length));
      cursor += encoded.length;
    }
    // 106C90 verifies actual encoded streams before 109F30 publishes total length.
    for (let row = 0; row < rows; row++) {
      const encoded = encodedRows[row]!,
        original = coefficientRows[row]!;
      const verified = decodeBurikoBfCoefficients(
        encoded.storage.bytes,
        original.length,
        encoded.length,
        trees.dc,
        trees.ac,
        undefined,
        undefined,
        0,
        encoded.storage.initializedRange(0, encoded.storage.bytes.length),
      );
      for (let index = 0; index < original.length; index++)
        if (verified[index] !== original[index])
          throw new BurikoResourceCodecException(
            3,
            'Buriko encoder coefficient verification failed',
          );
    }
    if (skip !== 0) {
      const encoded = alpha as unknown as ReturnType<typeof encodeBurikoBfAlphaLz>;
      const verified = {
        bytes: new Uint8Array(pixels.length),
        initialized: new Uint8Array(pixels.length),
      };
      decodeBurikoBfAlphaLz(
        encoded.storage.bytes.subarray(0, encoded.length),
        verified,
        stride,
        pixels.length,
      );
      for (let index = 3; index < pixels.length; index += 4) {
        if (verified.initialized[index] === 0)
          throw new BurikoUndefinedResourceRead(
            'Buriko encoder verification reads unwritten alpha',
          );
        if (verified.bytes[index] !== pixels[index])
          throw new BurikoResourceCodecException(3, 'Buriko encoder alpha verification failed');
      }
    }
    return {status: 0, length: cursor};
  } catch (error) {
    if (error instanceof BurikoResourceCodecException)
      return {status: error.code === 3 ? 6 : error.code === 11 ? 8 : 9};
    throw error;
  }
}

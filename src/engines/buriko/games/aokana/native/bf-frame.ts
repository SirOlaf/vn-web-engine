import {view} from '../../../../../formats/buriko/binary.js';
import {
  requireAokanaResourceRange as checkRange,
  AokanaBfBits as Bits,
  aokanaBfVarint as unsignedVarint,
  aokanaBfTree as movieFrequencyTree,
  aokanaBfSymbol,
  aokanaBfSignedBits as movieSignedBits,
  type AokanaBfTree,
} from './bf-entropy.js';
import {movieZigzag} from '../../../../../formats/buriko/bf-movie.js';
import {movieIdct} from '../../../../../formats/buriko/movie-idct.js';
import {AokanaUndefinedResourceRead, AokanaResourceCodecException} from './resource-memory.js';
import type {AokanaDistributedProcessing} from './distributed-processing.js';

export interface AokanaBfSurface {
  readonly bytes: Uint8Array;
  /** A zero marks bytes retained from the native uninitialized destination allocation. */
  readonly initialized: Uint8Array;
}

const f = Math.fround;
const clip = (value: number): number => Math.max(0, Math.min(255, Math.trunc(value)));
const colorTable = new Float32Array(1024);
for (let index = 0; index < 256; index++) {
  const chroma = f(index - 128);
  colorTable[index] = f(chroma * 1.402 + 0.5);
  colorTable[256 + index] = f(chroma * -0.34414);
  colorTable[512 + index] = f(0.5 - chroma * 0.71414);
  colorTable[768 + index] = f(chroma * 1.772 + 0.5);
}
function colorLookup(base: number, index: number): number {
  const value = colorTable[base + index];
  if (value === undefined)
    throw new AokanaUndefinedResourceRead(
      'Aokana BF color lookup reads outside initialized native lookup storage',
    );
  return value;
}

/** Actual 104010/103C70 pair, also used by the native encoder's coefficient verification. */
export function decodeAokanaBfCoefficients(
  bytes: Uint8Array,
  count: number,
  limit: number,
  dcTree: AokanaBfTree,
  acTree: AokanaBfTree,
  coefficients = new Int16Array(Math.ceil(count / 8) * 8),
  defined = new Uint8Array(coefficients.length),
  base = 0,
  inputInitialized?: Uint8Array,
): Int16Array {
  const cleared = Math.ceil(count / 8) * 8;
  checkRange(coefficients.length, base, cleared);
  coefficients.fill(0, base, base + cleared);
  defined.fill(1, base, base + cleared);
  const dcBits = new Bits(bytes, inputInitialized);
  let dc = 0;
  for (let index = 0; index < count && Math.floor(dcBits.position / 8) < limit; index += 64) {
    dc = ((dc + movieSignedBits(dcBits, aokanaBfSymbol(dcBits, dcTree))) << 16) >> 16;
    coefficients[base + index] = dc;
  }
  const acBits = new Bits(
    bytes.subarray(Math.ceil(dcBits.position / 8)),
    inputInitialized?.subarray(Math.ceil(dcBits.position / 8)),
  );
  for (let index = 0; index < count && Math.floor(acBits.position / 8) < limit; index += 64) {
    for (let order = 1; order < 64;) {
      const symbol = aokanaBfSymbol(acBits, acTree);
      if (symbol === 0) break;
      if (symbol === 15) {
        order += 16;
        continue;
      }
      const targetOrder = order + (symbol & 15),
        target = movieZigzag[targetOrder];
      if (target === undefined)
        throw new AokanaUndefinedResourceRead('Aokana BF AC run reads beyond native zigzag table');
      const at = base + index + target;
      checkRange(coefficients.length, at, 1);
      coefficients[at] = movieSignedBits(acBits, (symbol >>> 4) & 15);
      defined[at] = 1;
      order = targetOrder + 1;
    }
  }
  return coefficients;
}

/** 140105f30 native frame path, including raw coefficient counts and destination retention. */
export function decodeAokanaBfFrame(
  frame: Uint8Array,
  width: number,
  height: number,
  depth: number,
  quantization: Uint8Array,
  processing: AokanaDistributedProcessing,
  destination?: AokanaBfSurface,
  version = 0x10001,
  actor = processing.allocator.currentActor,
): AokanaBfSurface {
  checkRange(quantization.length, 0, 128);
  const alignedWidth = (width + 7) & ~7,
    alignedHeight = (height + 7) & ~7;
  const columns = alignedWidth >>> 3,
    rows = alignedHeight >>> 3,
    maskSize = (columns + 7) >>> 3;
  const frameExtent = Math.imul(Math.imul(width, height), 4) >>> 0;
  const surface = destination ?? {
    bytes: new Uint8Array(width * height * 4),
    initialized: new Uint8Array(width * height * 4),
  };
  checkRange(surface.bytes.length, 0, width * height * 4);
  checkRange(surface.initialized.length, 0, width * height * 4);
  const cursor = {position: 0};
  const dcTree = movieFrequencyTree(Array.from({length: 16}, () => unsignedVarint(frame, cursor)));
  const acTree = movieFrequencyTree(Array.from({length: 176}, () => unsignedVarint(frame, cursor)));
  checkRange(frame.length, cursor.position, (rows + 1) * 4);
  const data = view(frame);
  const offsets = Array.from({length: rows + 1}, (_, index) =>
    data.getUint32(cursor.position + index * 4, true),
  );
  const coefficients = new Int16Array(alignedWidth * alignedHeight * 3);
  const defined = new Uint8Array(coefficients.length);
  const requireCoefficients = (start: number, length: number): void => {
    checkRange(coefficients.length, start, length);
    for (let index = start; index < start + length; index++) {
      if (defined[index] === 0)
        throw new AokanaUndefinedResourceRead(
          'Aokana BF reconstruction reads unwritten coefficient storage',
        );
    }
  };
  const descriptors = Array.from({length: rows}, (_, row) => {
    const start = offsets[row]!,
      rowCursor = {position: start + maskSize};
    const count = unsignedVarint(frame, rowCursor);
    return {
      start,
      count,
      dataStart: rowCursor.position,
      limit: (offsets[row + 1]! - start - maskSize) >>> 0,
    };
  });
  // 105f30 selects/validates the alpha decoder before starting any work callback.
  let alphaMode = 0,
    alphaStart = 0;
  if (depth === 32) {
    alphaStart = offsets[rows]!;
    if (version === 0x10000) alphaMode = 1;
    else {
      if (version !== 0x10001)
        throw new AokanaResourceCodecException(9, `Aokana native BF version exception: ${version}`);
      checkRange(frame.length, alphaStart, 4);
      alphaMode = data.getUint32(alphaStart, true);
      alphaStart += 4;
    }
    if (alphaMode !== 1 && alphaMode !== 2)
      throw new AokanaResourceCodecException(
        9,
        `Aokana native BF alpha codec exception: ${alphaMode}`,
      );
  }
  const decodeRow = (row: number): void => {
    const {start, count, dataStart, limit} = descriptors[row]!;
    const rowCursor = {position: dataStart};
    // 105cf0 skips the entire color worker when count==0, irrespective of mask bits.
    if (count === 0) return;
    checkRange(frame.length, start, maskSize);
    const mask = frame.subarray(start, start + maskSize);
    const base = row * alignedWidth * 24;
    decodeAokanaBfCoefficients(
      frame.subarray(rowCursor.position),
      count,
      limit,
      dcTree,
      acTree,
      coefficients,
      defined,
      base,
    );
    const channels = depth >>> 3,
      components = channels === 4 ? 3 : channels;
    if (components === 0)
      throw new AokanaUndefinedResourceRead('Aokana BF reconstruction divides by zero components');
    const stride = components === 1 ? 0 : Math.floor((count >>> 3) / components) * 8;
    let block = 0;
    for (let column = 0; column < columns; column++) {
      if ((mask[column >>> 3]! & (1 << (column & 7))) === 0) continue;
      for (let component = 0; component < components; component++) {
        const at = base + component * stride + block * 64;
        requireCoefficients(at, 64);
        const transformed = movieIdct(
          coefficients.subarray(at, at + 64),
          quantization.subarray(component === 0 ? 0 : 64, component === 0 ? 64 : 128),
        );
        // Native PACKUSWB saturates every IDCT value before writing it back as a word.
        for (let index = 0; index < 64; index++)
          coefficients[at + index] = clip(transformed[index]!);
      }
      const first = base + block * 64;
      for (let yy = 0; yy < 8 && row * 8 + yy < height; yy++) {
        for (let xx = 0; xx < 8 && column * 8 + xx < width; xx++) {
          const sample = yy * 8 + xx,
            at = ((row * 8 + yy) * width + column * 8 + xx) * 4;
          if ((xx & 3) === 0) {
            // Native reads each SIMD group of four words even for a cropped1..3-pixel tail.
            for (let plane = 0; plane < 3; plane++)
              requireCoefficients(first + plane * stride + sample, 4);
            if (components !== 1)
              for (let tail = 0; tail < 4; tail++) {
                const cb = coefficients[first + stride + sample + tail]!,
                  cr = coefficients[first + stride * 2 + sample + tail]!;
                colorLookup(768, cb);
                colorLookup(256, cb);
                colorLookup(512, cr);
                colorLookup(0, cr);
              }
          }
          const y = coefficients[first + sample]!,
            cb = coefficients[first + stride + sample]!,
            cr = coefficients[first + stride * 2 + sample]!;
          surface.bytes[at] = components === 1 ? y : clip(f(y + colorLookup(768, cb)));
          surface.bytes[at + 1] =
            components === 1 ? y : clip(f(f(colorLookup(256, cb) + y) + colorLookup(512, cr)));
          surface.bytes[at + 2] = components === 1 ? y : clip(f(y + colorLookup(0, cr)));
          surface.initialized.fill(1, at, at + 3);
        }
      }
      block++;
    }
  };
  let nextDescriptor = 0;
  processing.setCallback(() => {
    const shared = processing.enterShared();
    const descriptor = nextDescriptor <= rows ? nextDescriptor++ : -1;
    processing.leaveShared(shared);
    if (descriptor < 0) return 0;
    if (descriptor === 0) {
      if (depth !== 32) {
        for (let at = 3; at < frameExtent; at += 4) {
          surface.bytes[at] = 0;
          surface.initialized[at] = 1;
        }
      } else if (alphaMode === 1)
        decodeAokanaBfAlphaLz(frame.subarray(alphaStart), surface, width * 4, frameExtent);
      else decodeAlphaBlocks(frame.subarray(alphaStart), surface, width, height, columns, rows);
    } else decodeRow(descriptor - 1);
    return 1;
  }, null);
  processing.run(1, actor);
  processing.setCallback(null, null);
  return surface;
}

export function decodeAokanaBfAlphaLz(
  bytes: Uint8Array,
  surface: AokanaBfSurface,
  stride: number,
  frameExtent: number,
): void {
  const data = view(bytes);
  let cursor = 0,
    output = 3;
  while (output < frameExtent) {
    checkRange(bytes.length, cursor, 1);
    const control = bytes[cursor++]!;
    for (let bit = 0; bit < 8 && output < frameExtent; bit++) {
      if (control & (1 << bit)) {
        checkRange(bytes.length, cursor, 2);
        const code = data.getUint16(cursor, true);
        cursor += 2;
        let dx = code & 63,
          dy = (code >>> 6) & 7;
        if (dx > 31) dx -= 64;
        if (dy !== 0) dy -= 8;
        const count = (code >>> 9) + 3,
          distance = Math.imul(dy, stride) + dx * 4;
        for (let index = 0; index < count; index++, output += 4) {
          const source = (output + distance) >>> 0;
          checkRange(surface.bytes.length, source, 1);
          checkRange(surface.bytes.length, output, 1);
          if (surface.initialized[source] === 0)
            throw new AokanaUndefinedResourceRead(
              'Aokana BF alpha LZ reads an unwritten destination byte',
            );
          surface.bytes[output] = surface.bytes[source]!;
          surface.initialized[output] = 1;
        }
      } else {
        checkRange(bytes.length, cursor, 1);
        surface.bytes[output] = bytes[cursor++]!;
        surface.initialized[output] = 1;
        output += 4;
      }
    }
  }
}

function decodeAlphaBlocks(
  bytes: Uint8Array,
  surface: AokanaBfSurface,
  width: number,
  height: number,
  columns: number,
  rows: number,
): void {
  checkRange(bytes.length, 0, 4);
  const size = view(bytes).getUint32(0, true),
    cursor = {position: 4};
  const tree = movieFrequencyTree(Array.from({length: 256}, () => unsignedVarint(bytes, cursor)));
  const bits = new Bits(bytes.subarray(cursor.position));
  const decoded = new Uint8Array(((width + 7) & ~7) * ((height + 7) & ~7) * 2);
  checkRange(decoded.length, 0, size);
  for (let index = 0; index < size; index++) decoded[index] = aokanaBfSymbol(bits, tree);
  const maskSize = (columns * rows + 7) >>> 3;
  checkRange(size, 0, maskSize);
  let read = maskSize;
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++) {
      const block = row * columns + column;
      if ((decoded[block >>> 3]! & (1 << (block & 7))) === 0) continue;
      for (let yy = row * 8; yy < Math.min(row * 8 + 8, height); yy++)
        for (let xx = column * 8; xx < Math.min(column * 8 + 8, width); xx++) {
          if (read >= size)
            throw new AokanaUndefinedResourceRead(
              'Aokana BF alpha mask reads unwritten Huffman output',
            );
          const at = (yy * width + xx) * 4 + 3;
          surface.bytes[at] = decoded[read++]!;
          surface.initialized[at] = 1;
        }
    }
  // Native leaves unused Huffman bytes alone; it does not require read==size.
}

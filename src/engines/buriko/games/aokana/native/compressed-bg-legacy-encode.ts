import {frequencyTree} from '../../../../../formats/buriko/compressed-bg.js';
import {randomByteGenerator} from '../../../../../formats/buriko/binary.js';
import {pointerView, type AokanaBpPointer} from '../bp/memory.js';
import type {AokanaSystemTicks} from './system-ticks.js';

/** BFC00 and its legacy predictor/run/tree/header/bitstream producers. */
export class AokanaLegacyBgEncoder {
  constructor(readonly ticks: AokanaSystemTicks) {}

  encode(output: AokanaBpPointer, count: AokanaBpPointer, source: AokanaBpPointer): number {
    const word = (offset: number): number =>
        pointerView({bytes: source.bytes, offset: source.offset + offset}, 2).getUint16(0, true),
      byte = (offset: number): number =>
        pointerView({bytes: source.bytes, offset: source.offset + offset}, 1).getUint8(0);
    // BF970 consumes individual fields, not an eagerly validated packed payload.
    if (word(0) === 0 || word(2) === 0) return 0x80000001;
    const depth = word(4);
    if (![8, 16, 24, 32, 48].includes(depth) || word(8) >= 7) return 0x80000001;
    if (depth === 16 || depth === 48) return 0x80000002;
    const height = word(2),
      channels = word(4) >>> 3,
      width = word(0),
      size = Math.imul(Math.imul(channels, height), width) >>> 0,
      residual = new Uint8Array(size),
      runs = new Uint8Array((size * 2) >>> 0);
    const read = (bytes: Uint8Array, offset: number): number => {
      const value = bytes[offset];
      if (value === undefined)
        throw new Error('Aokana legacy BG encoder reads outside owned storage');
      return value;
    };
    const write = (bytes: Uint8Array, offset: number, value: number): void => {
      if (offset < 0 || offset >= bytes.length)
        throw new Error('Aokana legacy BG encoder writes outside owned storage');
      bytes[offset] = value;
    };
    let residualOffset = 0;
    for (let y = 0; y < word(2); y++) {
      for (let x = 0; x < word(0); x++) {
        for (let channel = 0; channel < channels; channel++) {
          const offset = (Math.imul((Math.imul(y, word(0)) + x) >>> 0, channels) + channel) >>> 0;
          let predictor = 0;
          if (y > 0) predictor = byte(16 + ((offset - Math.imul(word(0), channels)) >>> 0));
          if (x > 0) {
            const left = byte(16 + ((offset - channels) >>> 0));
            predictor = y > 0 ? (predictor + left) >>> 1 : left;
          }
          write(residual, residualOffset++, byte(16 + offset) - predictor);
        }
      }
    }
    let runLength = 0;
    const runByte = (value: number): void => write(runs, runLength++, value);
    const varint = (value: number, emit: (byte: number) => void): void => {
      do {
        emit((value & 127) | (value >= 128 ? 128 : 0));
        value >>>= 7;
      } while (value !== 0);
    };
    let literal = true,
      length = 0,
      start = 0,
      index = 0;
    while (index < size) {
      const value = read(residual, index);
      let transition = false;
      if (literal) {
        // BF230 really reads one beyond a final literal-mode zero. Do not synthesize a sentinel.
        if (value === 0 && read(residual, (index + 1) >>> 0) === 0) transition = true;
        else {
          length++;
          index++;
        }
      } else if (value !== 0) {
        start = index;
        transition = true;
      } else {
        length++;
        index++;
      }
      if (transition || index >= size) {
        varint(length, runByte);
        if (literal) for (let i = 0; i < length; i++) runByte(read(residual, start + i));
        literal = !literal;
        length = 0;
      }
    }
    const frequencies = new Array<number>(256).fill(0);
    for (let i = 0; i < runLength; i++) {
      const symbol = read(runs, i);
      frequencies[symbol] = (frequencies[symbol]! + 1) >>> 0;
    }
    const tree = frequencyTree(frequencies),
      codes: number[][] = Array.from({length: 256}, () => []),
      pending: {node: number; bits: number[]}[] = [{node: tree.root, bits: []}];
    while (pending.length !== 0) {
      const {node, bits} = pending.pop()!;
      if (node < 256) codes[node] = bits;
      else
        tree.children[node]!.forEach((child, branch) =>
          pending.push({node: child, bits: [...bits, branch]}),
        );
    }
    const outputView = (offset: number, length: number): DataView =>
        pointerView({bytes: output.bytes, offset: output.offset + offset}, length),
      storeByte = (offset: number, value: number): void => outputView(offset, 1).setUint8(0, value);
    outputView(0, 8).setBigUint64(0, 0n, true);
    outputView(8, 8).setBigUint64(0, 0n, true);
    for (const [i, char] of Array.from('CompressedBG___\0').entries())
      storeByte(i, char.charCodeAt(0));
    const header = new Uint8Array(
      pointerView(source, 16).buffer,
      source.bytes.byteOffset + source.offset,
      16,
    ).slice();
    outputView(32, 4).setUint32(0, runLength, true);
    const headerOutput = outputView(16, 16);
    new Uint8Array(headerOutput.buffer, headerOutput.byteOffset, 16).set(header);
    const seed = this.ticks.getTickCount();
    outputView(36, 4).setUint32(0, seed, true);
    let tableLength = 0;
    for (const frequency of frequencies)
      varint(frequency, (value) => storeByte(48 + tableLength++, value));
    outputView(40, 4).setUint32(0, tableLength, true);
    let sum = 0,
      xor = 0;
    for (let i = 0; i < tableLength; i++) {
      const value = outputView(48 + i, 1).getUint8(0);
      sum = (sum + value) & 255;
      xor ^= value;
    }
    storeByte(44, sum);
    storeByte(45, xor);
    outputView(46, 2).setUint16(0, 1, true);
    const random = randomByteGenerator(seed);
    for (let i = 0; i < tableLength; i++)
      storeByte(48 + i, outputView(48 + i, 1).getUint8(0) + random());
    let outputLength = 48 + tableLength,
      accumulator = 0,
      used = 0;
    for (let i = 0; i < runLength; i++) {
      // BEE70/BE7D0 consume only the initialized code prefix, not unused record padding.
      for (const bit of codes[read(runs, i)]!) {
        accumulator |= bit << (7 - used++);
        if (used === 8) {
          storeByte(outputLength++, accumulator);
          accumulator = 0;
          used = 0;
        }
      }
    }
    if (used !== 0) storeByte(outputLength++, accumulator);
    pointerView(count, 4).setUint32(0, outputLength >>> 0, true);
    return 0;
  }
}

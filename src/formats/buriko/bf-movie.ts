import {checkRange} from '../../core/binary.js';
import type {ByteSource} from '../../core/source.js';
import {Bits, signature, unsignedVarint, view} from './binary.js';

import {movieIdct} from './movie-idct.js';
const zigzag = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
  13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52,
  45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];
interface Tree {
  root: number;
  children: number[][];
}
// 0x140103150 scans from branch+1 after selecting the first active node.
// On its second selection it can deliberately skip node 1 when node 0 is active.
function frequencyTree(weights: readonly number[]): Tree {
  const frequencies = [...weights],
    active = weights.map((w) => w !== 0),
    children = weights.map(() => [] as number[]);
  if (!active.some(Boolean)) throw new Error('Empty BF_Movie frequency table');
  for (;;) {
    const pair: number[] = [];
    for (let branch = 0; branch < 2; branch++) {
      let best = active.findIndex(Boolean);
      if (best < 0) break;
      for (let i = branch + 1; i < frequencies.length; i++)
        if (active[i] && frequencies[i]! < frequencies[best]!) best = i;
      active[best] = false;
      pair.push(best);
    }
    const root = frequencies.length;
    children.push(pair);
    frequencies.push(pair.reduce((sum, i) => sum + frequencies[i]!, 0));
    active.push(true);
    if (active.filter(Boolean).length === 1) return {root, children};
  }
}
function symbol(bits: Bits, tree: Tree, leaves: number): number {
  let node = tree.root;
  while (node >= leaves) {
    const next = tree.children[node]![bits.read(1)];
    if (next === undefined) throw new Error('Invalid BF_Movie Huffman code');
    node = next;
  }
  return node;
}
function signedBits(bits: Bits, count: number): number {
  const value = bits.read(count);
  return count && value < 2 ** (count - 1) ? value - (2 ** count - 1) : value;
}
const f = Math.fround;
const clamp = (v: number) => Math.max(0, Math.min(255, Math.trunc(v)));
/** Native 0x1401091b0 / 0x140105f30, BF_Movie 0x10001, including both alpha codecs. */
export class BfMovie {
  private readonly pixels: Uint8Array;
  private frameIndex = -1;
  private constructor(
    readonly source: ByteSource,
    readonly width: number,
    readonly height: number,
    readonly bitDepth: number,
    readonly surfaceType: number,
    readonly fps: number,
    readonly frameCount: number,
    readonly quantization: Uint8Array,
    readonly offsets: readonly number[],
  ) {
    this.pixels = new Uint8Array(width * height * 4);
  }
  static async open(source: ByteSource): Promise<BfMovie> {
    const header = await source.read(0, 0xc0),
      data = view(header);
    if (!signature(header, 'BF_Movie_______\0') || data.getUint32(16, true) !== 0x10001)
      throw new Error('Not BF_Movie 0x10001');
    const width = data.getUint32(20, true),
      height = data.getUint32(24, true),
      depth = data.getUint32(28, true),
      surfaceType = data.getUint32(32, true),
      fps = data.getUint32(36, true),
      count = data.getUint32(40, true);
    if (
      !width ||
      !height ||
      width * height > 0x4000000 ||
      ![24, 32].includes(depth) ||
      !fps ||
      !count
    )
      throw new Error('Invalid BF_Movie geometry or timing');
    checkRange(source.size, 0xc0, count * 4);
    const table = view(await source.read(0xc0, count * 4)),
      offsets = Array.from({length: count}, (_, i) => table.getUint32(i * 4, true));
    for (let i = 0; i < count; i++) {
      if (offsets[i]! < 0xc0 + count * 4 || offsets[i]! >= (offsets[i + 1] ?? source.size))
        throw new Error('Invalid BF_Movie frame offsets');
    }
    return new BfMovie(
      source,
      width,
      height,
      depth,
      surfaceType,
      fps,
      count,
      header.slice(64, 192),
      offsets,
    );
  }
  /** Seeking replays preceding frames because clear block-mask bits retain the destination. */
  async frame(index: number): Promise<Uint8Array> {
    if (!Number.isInteger(index) || index < 0 || index >= this.frameCount)
      throw new Error('BF_Movie frame out of range');
    if (index < this.frameIndex) {
      this.pixels.fill(0);
      this.frameIndex = -1;
    }
    while (this.frameIndex < index) {
      const next = this.frameIndex + 1,
        start = this.offsets[next]!,
        end = this.offsets[next + 1] ?? this.source.size;
      const bytes = await this.source.read(start, end - start);
      const output = this.pixels.slice();
      this.decodeFrame(bytes, output);
      this.pixels.set(output);
      this.frameIndex = next;
    }
    return this.pixels.slice();
  }
  private decodeFrame(bytes: Uint8Array, output: Uint8Array): void {
    const cursor = {position: 0};
    const dcTree = frequencyTree(Array.from({length: 16}, () => unsignedVarint(bytes, cursor)));
    const acTree = frequencyTree(Array.from({length: 176}, () => unsignedVarint(bytes, cursor)));
    const columns = Math.ceil(this.width / 8),
      rows = Math.ceil(this.height / 8),
      maskSize = Math.ceil(columns / 8);
    checkRange(bytes.length, cursor.position, (rows + (this.bitDepth === 32 ? 1 : 0)) * 4);
    const data = view(bytes),
      offsets = Array.from({length: rows + (this.bitDepth === 32 ? 1 : 0)}, (_, i) =>
        data.getUint32(cursor.position + i * 4, true),
      );
    const minimum = cursor.position + (rows + (this.bitDepth === 32 ? 1 : 0)) * 4;
    for (let y = 0; y < rows; y++) {
      const start = offsets[y]!,
        end = this.bitDepth === 24 && y === rows - 1 ? bytes.length : offsets[y + 1]!;
      if (start < minimum || end < start) throw new Error('Invalid BF_Movie row offsets');
      checkRange(bytes.length, start, end - start);
      checkRange(end, start, maskSize);
      const mask = bytes.subarray(start, start + maskSize),
        row = {position: start + maskSize};
      const count = unsignedVarint(bytes, row);
      let changed = 0;
      for (let x = 0; x < columns; x++) if (mask[x >>> 3]! & (1 << (x & 7))) changed++;
      if (count !== changed * 64 * 3)
        throw new Error('BF_Movie coefficient count does not match block mask');
      if (!count) continue;
      const coefficients = new Int16Array(count),
        dcBits = new Bits(bytes.subarray(row.position, end));
      let dc = 0;
      for (let p = 0; p < count; p += 64) {
        dc = ((dc + signedBits(dcBits, symbol(dcBits, dcTree, 16))) << 16) >> 16;
        coefficients[p] = dc;
      }
      const acStart = row.position + Math.ceil(dcBits.position / 8),
        acBits = new Bits(bytes.subarray(acStart, end));
      for (let p = 0; p < count; p += 64) {
        for (let k = 1; k < 64;) {
          const code = symbol(acBits, acTree, 176);
          if (!code) break;
          if (code === 15) {
            k += 16;
            if (k > 64) throw new Error('BF_Movie AC zero run overflow');
            continue;
          }
          k += code & 15;
          if (k >= 64) throw new Error('BF_Movie AC coefficient overflow');
          coefficients[p + zigzag[k]!] = signedBits(acBits, code >>> 4);
          k++;
        }
      }
      let block = 0;
      for (let x = 0; x < columns; x++) {
        if (!(mask[x >>> 3]! & (1 << (x & 7)))) continue;
        const planes = Array.from({length: 3}, (_, c) => {
          const p = (c * changed + block) * 64;
          return movieIdct(
            coefficients.subarray(p, p + 64),
            this.quantization.subarray(c ? 64 : 0, c ? 128 : 64),
          );
        });
        for (let yy = 0; yy < 8 && y * 8 + yy < this.height; yy++)
          for (let xx = 0; xx < 8 && x * 8 + xx < this.width; xx++) {
            const p = yy * 8 + xx,
              dst = ((y * 8 + yy) * this.width + x * 8 + xx) * 4,
              luma = planes[0]![p]!,
              cb = planes[1]![p]! - 128,
              cr = planes[2]![p]! - 128;
            output[dst] = clamp(f(luma + f(f(cb * f(1.772)) + 0.5)));
            output[dst + 1] = clamp(f(f(f(cb * f(-0.34414)) + luma) + f(0.5 - f(cr * f(0.71414)))));
            output[dst + 2] = clamp(f(luma + f(f(cr * f(1.402)) + 0.5)));
          }
        block++;
      }
    }
    if (this.bitDepth === 24) {
      for (let p = 3; p < output.length; p += 4) output[p] = 0;
      return;
    }
    const alphaStart = offsets[rows]!;
    checkRange(bytes.length, alphaStart, 4);
    const mode = data.getUint32(alphaStart, true),
      alpha = bytes.subarray(alphaStart + 4);
    if (mode === 1) this.decodeAlphaLz(alpha, output);
    else if (mode === 2) this.decodeAlphaBlocks(alpha, output, columns, rows);
    else throw new Error(`Invalid BF_Movie alpha codec ${mode}`);
  }
  private decodeAlphaLz(bytes: Uint8Array, output: Uint8Array): void {
    const data = view(bytes);
    let p = 0,
      q = 3;
    while (q < output.length) {
      checkRange(bytes.length, p, 1);
      const control = bytes[p++]!;
      for (let bit = 0; bit < 8 && q < output.length; bit++) {
        if (control & (1 << bit)) {
          checkRange(bytes.length, p, 2);
          const code = data.getUint16(p, true);
          p += 2;
          let dx = code & 63,
            dy = (code >>> 6) & 7;
          if (dx > 31) dx -= 64;
          if (dy) dy -= 8;
          const count = (code >>> 9) + 3,
            distance = dy * this.width * 4 + dx * 4;
          if (distance >= 0 || q + distance < 3)
            throw new Error('Invalid BF_Movie alpha backreference');
          checkRange(output.length, q, (count - 1) * 4 + 1);
          for (let i = 0; i < count; i++, q += 4) output[q] = output[q + distance]!;
        } else {
          checkRange(bytes.length, p, 1);
          output[q] = bytes[p++]!;
          q += 4;
        }
      }
    }
  }
  private decodeAlphaBlocks(
    bytes: Uint8Array,
    output: Uint8Array,
    columns: number,
    rows: number,
  ): void {
    checkRange(bytes.length, 0, 4);
    const size = view(bytes).getUint32(0, true),
      cursor = {position: 4};
    if (size > this.width * this.height + Math.ceil((columns * rows) / 8))
      throw new Error('BF_Movie alpha size exceeds image');
    const tree = frequencyTree(Array.from({length: 256}, () => unsignedVarint(bytes, cursor))),
      bits = new Bits(bytes.subarray(cursor.position)),
      decoded = new Uint8Array(size);
    for (let i = 0; i < size; i++) decoded[i] = symbol(bits, tree, 256);
    const maskSize = Math.ceil((columns * rows) / 8);
    checkRange(size, 0, maskSize);
    let p = maskSize;
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < columns; x++) {
        const block = y * columns + x;
        if (!(decoded[block >>> 3]! & (1 << (block & 7)))) continue;
        for (let yy = y * 8; yy < Math.min(y * 8 + 8, this.height); yy++)
          for (let xx = x * 8; xx < Math.min(x * 8 + 8, this.width); xx++) {
            checkRange(size, p, 1);
            output[(yy * this.width + xx) * 4 + 3] = decoded[p++]!;
          }
      }
    if (p !== size) throw new Error('BF_Movie alpha block size mismatch');
  }
}

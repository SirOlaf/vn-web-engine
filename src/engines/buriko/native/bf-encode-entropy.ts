import {BurikoBitmapStorage} from './bitmap.js';
import {
  burikoBfTree,
  type BurikoBfTree,
  requireBurikoResourceRange as checkRange,
} from './bf-entropy.js';
import {movieZigzag} from '../../../formats/buriko/bf-movie.js';

export function burikoBfWriteByte(
  storage: BurikoBitmapStorage,
  offset: number,
  value: number,
): void {
  storage.range(offset, 1, false);
  storage.bytes[offset] = value;
  storage.written(offset, 1);
}
export function burikoBfWriteBytes(
  storage: BurikoBitmapStorage,
  offset: number,
  bytes: Uint8Array,
): void {
  storage.range(offset, bytes.length, false);
  storage.bytes.set(bytes, offset);
  storage.written(offset, bytes.length);
}
/** 1042F0's unsigned seven-bit continuation bytes. */
export function burikoBfEncodedVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  value >>>= 0;
  do {
    const next = value >>> 7;
    bytes.push((value & 127) | (next !== 0 ? 128 : 0));
    value = next;
  } while (value !== 0);
  return Uint8Array.from(bytes);
}
function category(value: number, maximum: number): number {
  const magnitude = (value ^ (value >> 31)) - (value >> 31);
  for (let count = maximum - 1; count > 0; count--)
    if ((magnitude & (1 << (count - 1))) !== 0) return count;
  return 0;
}
interface Token {
  symbol: number;
  value: number;
  bits: number;
}
function acTokens(coefficients: Int16Array): Token[] {
  const result: Token[] = [];
  for (let block = 0; block < coefficients.length; block += 64) {
    let zeros = 0;
    for (let order = 1; order < 64; order++) {
      const value = coefficients[block + movieZigzag[order]!]!;
      if (value === 0) {
        zeros++;
        continue;
      }
      while (zeros >= 16) {
        result.push({symbol: 15, value: 0, bits: 0});
        zeros -= 16;
      }
      const bits = category(value, 11);
      result.push({symbol: (bits << 4) | zeros, value: value < 0 ? value - 1 : value, bits});
      zeros = 0;
    }
    if (zeros !== 0) result.push({symbol: 0, value: 0, bits: 0});
  }
  return result;
}
function dcTokens(coefficients: Int16Array): Token[] {
  const result: Token[] = [];
  let previous = 0;
  for (let index = 0; index < coefficients.length; index += 64) {
    const current = coefficients[index]!,
      delta = current - previous,
      bits = category(delta, 16);
    result.push({symbol: bits, value: delta < 0 ? delta - 1 : delta, bits});
    previous = current;
  }
  return result;
}
export function burikoBfEncoderTrees(rows: readonly Int16Array[]): {
  dc: BurikoBfTree;
  ac: BurikoBfTree;
  frequencies: readonly number[];
} {
  const dc = Array<number>(16).fill(0),
    ac = Array<number>(176).fill(0);
  for (const row of rows) {
    for (const token of dcTokens(row)) dc[token.symbol] = (dc[token.symbol]! + 1) >>> 0;
    for (const token of acTokens(row)) ac[token.symbol] = (ac[token.symbol]! + 1) >>> 0;
  }
  return {dc: burikoBfTree(dc), ac: burikoBfTree(ac), frequencies: [...dc, ...ac]};
}
function paths(tree: BurikoBfTree): number[][] {
  const parent = new Map<number, readonly [number, number]>();
  for (let node = tree.leaves; node <= tree.root; node++)
    for (let bit = 0; bit < 2; bit++) {
      const child = tree.children[node]![bit]!;
      if (child !== 0xffffffff) parent.set(child, [node, bit]);
    }
  return Array.from({length: tree.leaves}, (_, symbol) => {
    const path: number[] = [];
    let node = symbol;
    while (parent.has(node) && path.length < 511) {
      const edge = parent.get(node)!;
      path.push(edge[1]);
      node = edge[0];
    }
    return path.reverse();
  });
}
/** 103A40/1038C0 OR into current bytes and clear a new byte only below capacity. */
function writeTokens(
  storage: BurikoBitmapStorage,
  start: number,
  capacity: number,
  tokens: readonly Token[],
  tree: BurikoBfTree,
): number {
  let position = 0,
    bit = 0;
  const codes = paths(tree);
  burikoBfWriteByte(storage, start, 0);
  const put = (value: number) => {
    storage.range(start + position, 1, true);
    burikoBfWriteByte(
      storage,
      start + position,
      storage.bytes[start + position]! | ((value & 1) << (7 - bit)),
    );
    if (++bit === 8) {
      position++;
      bit = 0;
      if (position < capacity) burikoBfWriteByte(storage, start + position, 0);
    }
  };
  for (const token of tokens) {
    for (const value of codes[token.symbol]!) put(value);
    for (let index = token.bits - 1; index >= 0; index--) put(token.value >>> index);
  }
  return position + (bit !== 0 ? 1 : 0);
}
export function encodeBurikoBfCoefficientRow(
  coefficients: Int16Array,
  dc: BurikoBfTree,
  ac: BurikoBfTree,
): {storage: BurikoBitmapStorage; length: number} {
  const capacity = coefficients.length * 4,
    storage = new BurikoBitmapStorage(new Uint8Array(capacity), false);
  const dcLength = writeTokens(storage, 0, capacity, dcTokens(coefficients), dc);
  const acLength = writeTokens(storage, dcLength, capacity - dcLength, acTokens(coefficients), ac);
  return {storage, length: dcLength + acLength};
}

/** 102980, the image encoder's no-previous-frame alpha mode one. */
export function encodeBurikoBfAlphaLz(
  input: Uint8Array,
  width: number,
  stride: number,
  capacity: number,
): {storage: BurikoBitmapStorage; length: number} {
  const storage = new BurikoBitmapStorage(new Uint8Array(capacity), false);
  let output = 1,
    flag = 0,
    bit = 0,
    position = 3;
  burikoBfWriteByte(storage, 0, 0);
  const read = (offset: number) => {
    checkRange(input.length, offset, 1);
    return input[offset]!;
  };
  while (position < input.length && output < capacity) {
    const pixel = position >>> 2,
      x = pixel % width,
      y = Math.floor(pixel / width);
    const left = x < 32 ? -x : -31,
      right = Math.min(width - x - 1, 31),
      top = y < 7 ? -y : -6;
    let length = 2,
      dx = 0,
      dy = 0;
    search: for (let yy = top; yy <= 0; yy++) {
      const last = yy === 0 ? -1 : right;
      if (left > last) continue;
      const currentAlpha = read(position);
      for (let xx = left; xx <= last; xx++) {
        const reference = (Math.imul(yy, stride) + xx * 4 + position) >>> 0;
        if (read(reference) !== currentAlpha) continue;
        let count = 1;
        while (
          count < 130 &&
          position + count * 4 < input.length &&
          read((reference + count * 4) >>> 0) === read(position + count * 4)
        )
          count++;
        if (count > length) {
          length = count;
          dx = xx;
          dy = yy;
          if (count === 130) break search;
        }
      }
    }
    if (length >= 3) {
      storage.range(flag, 1, true);
      burikoBfWriteByte(storage, flag, storage.bytes[flag]! | (1 << bit));
      const token = ((length - 3) << 9) | ((dy & 7) << 6) | (dx & 63);
      storage.range(output, 2, false);
      storage.view.setUint16(output, token, true);
      storage.written(output, 2);
      output += 2;
      position += length * 4;
    } else {
      burikoBfWriteByte(storage, output++, read(position));
      position += 4;
    }
    if (++bit === 8 && position < input.length && output < capacity) {
      flag = output++;
      bit = 0;
      burikoBfWriteByte(storage, flag, 0);
    }
  }
  return {storage, length: output};
}

import {BurikoUndefinedResourceRead} from './resource-memory.js';

export function requireBurikoResourceRange(size: number, offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > size
  ) {
    throw new BurikoUndefinedResourceRead(
      'Buriko resource access crosses native allocation storage',
    );
  }
}

/** 1401042a0: continuation length is unrestricted and x86 shifts wrap modulo32. */
export function burikoBfVarint(bytes: Uint8Array, cursor: {position: number}): number {
  let value = 0,
    shift = 0;
  for (;;) {
    requireBurikoResourceRange(bytes.length, cursor.position, 1);
    const byte = bytes[cursor.position++]!;
    value |= (byte & 127) << (shift & 31);
    if ((byte & 128) === 0) return value >>> 0;
    shift = (shift + 7) & 255;
  }
}

/** 140103970 also dereferences the current byte when count==0. */
export class BurikoBfBits {
  position = 0;
  constructor(
    readonly bytes: Uint8Array,
    private readonly initialized?: Uint8Array,
  ) {}
  read(count: number): number {
    const first = this.position >>> 3;
    const last = Math.floor((this.position + Math.max(1, count) - 1) / 8);
    requireBurikoResourceRange(this.bytes.length, first, last - first + 1);
    if (this.initialized !== undefined) {
      requireBurikoResourceRange(this.initialized.length, first, last - first + 1);
      for (let index = first; index <= last; index++)
        if (this.initialized[index] === 0)
          throw new BurikoUndefinedResourceRead(
            'Buriko BF bit reader consumes unwritten native storage',
          );
    }
    let value = 0;
    for (let index = 0; index < count; index++, this.position++) {
      value = (value << 1) | ((this.bytes[this.position >>> 3]! >>> (7 - (this.position & 7))) & 1);
    }
    return value >>> 0;
  }
  peekByte(): number {
    const position = this.position,
      value = this.read(8);
    this.position = position;
    return value;
  }
}

export interface BurikoBfTree {
  readonly leaves: number;
  readonly root: number;
  readonly children: readonly (readonly number[])[];
  readonly lookup: readonly ({length: number; node: number} | undefined)[];
}

/** 140103150/103300: unsigned frequencies, wrapping sums and partly unwritten lookahead tables. */
export function burikoBfTree(weights: readonly number[]): BurikoBfTree {
  const leaves = weights.length,
    capacity = leaves * 2 - 1;
  const active = Array.from(
    {length: capacity},
    (_, index) => index < leaves && weights[index] !== 0,
  );
  const frequencies = new Uint32Array(capacity);
  frequencies.set(weights);
  const children = Array.from({length: capacity}, () => [0xffffffff, 0xffffffff]);
  let total = 0;
  for (const weight of weights) total = (total + weight) >>> 0;
  let root = leaves;
  for (; root < capacity; root++) {
    let sum = 0;
    for (let branch = 0; branch < 2; branch++) {
      let best = -1;
      for (let index = 0; index < root; index++)
        if (active[index]) {
          best = index;
          break;
        }
      for (let index = branch + 1; index < root; index++) {
        if (active[index] && (best < 0 || frequencies[index]! < frequencies[best]!)) best = index;
      }
      if (best < 0) break;
      active[best] = false;
      children[root]![branch] = best;
      sum = (sum + frequencies[best]!) >>> 0;
    }
    active[root] = true;
    frequencies[root] = sum;
    if (sum >= total) break;
  }
  requireBurikoResourceRange(capacity, root, 1);
  const lookup: ({length: number; node: number} | undefined)[] = new Array(256);
  for (let prefix = 0; prefix < 256; prefix++) {
    let node = root;
    for (let depth = 1; depth <= 8; depth++) {
      node = children[node]![(prefix >>> (8 - depth)) & 1]!;
      if (node === 0xffffffff) break;
      if (node < leaves) {
        lookup[prefix] = {length: depth, node};
        break;
      }
      if (depth === 8) lookup[prefix] = {length: 0, node};
    }
  }
  return {leaves, root, children, lookup};
}

/** 140103b40 always performs the full eight-bit lookahead before selecting a short code. */
export function burikoBfSymbol(bits: BurikoBfBits, tree: BurikoBfTree): number {
  const entry = tree.lookup[bits.peekByte()];
  if (entry === undefined)
    throw new BurikoUndefinedResourceRead(
      'Buriko BF Huffman lookup reads unwritten native table entries',
    );
  if (entry.length !== 0) {
    bits.position += entry.length;
    return entry.node;
  }
  bits.position += 8;
  let node = entry.node;
  while (node >= tree.leaves) {
    requireBurikoResourceRange(tree.children.length, node, 1);
    node = tree.children[node]![bits.read(1)]!;
  }
  return node;
}

export function burikoBfSignedBits(bits: BurikoBfBits, count: number): number {
  const value = bits.read(count);
  return count !== 0 && value < 2 ** (count - 1) ? value - (2 ** count - 1) : value;
}

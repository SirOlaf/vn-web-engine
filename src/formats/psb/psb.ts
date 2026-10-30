import {ByteView} from '../../core/binary.js';

/** A data chunk referenced from the tree: an ordinary resource (value types 0x19-0x1c) or a
 * version-4 extra resource (0x22-0x25). */
export class PsbResource {
  constructor(
    readonly index: number,
    readonly extra: boolean,
    readonly bytes: Uint8Array,
  ) {}
}
export type PsbValue = null | boolean | number | string | PsbResource | PsbValue[] | PsbObject;
export interface PsbObject {
  [key: string]: PsbValue;
}

/**
 * XORs `bytes` in place with the E-mote keystream for `key`, from the stream origin.
 *
 * The keystream is a modified xorshift128 seeded with Marsaglia's first three words and the
 * key. Each state update yields one 32-bit word, consumed low byte first; a new word is drawn
 * when the remaining word is zero, so a word with zero high bytes is cut short.
 */
export function applyPsbKeystream(key: number, bytes: Uint8Array): void {
  let s0 = 123456789,
    s1 = 362436069,
    s2 = 521288629,
    s3 = key >>> 0,
    word = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (word === 0) {
      const t = (s0 ^ (s0 << 11)) >>> 0,
        w = s3;
      s0 = s1;
      s1 = s2;
      s2 = w;
      s3 = (w ^ t ^ ((t ^ (w >>> 11)) >>> 8)) >>> 0;
      word = s3;
    }
    bytes[i]! ^= word & 0xff;
    word >>>= 8;
  }
}

/**
 * PSB ("packed struct binary", M2 / E-mote) tree reader for versions 2 to 4.
 *
 * Header (little endian): `PSB\0`, u16 version, u16 flags, then u32 offsets of the name trie,
 * string offsets, string data, resource offsets, resource lengths, resource data and the root
 * value; version 3 adds a checksum and version 4 the extra-resource offset, length and data
 * tables (0x2c, 0x30, 0x34). Flag bit 0 marks a header filtered with the keystream of the
 * runtime's key: bytes 8 to 0x38 (version 4) or 8 to 0x2c (versions 2 and 3); `key` is
 * required for such files. Bodies filtered as a whole (flag bit 1) are not supported.
 *
 * Names are a double-array trie (charset, tree, name indices); strings an offset table into
 * NUL-terminated UTF-8; resources offset and length tables into a data area.
 */
export class PsbFile {
  readonly version: number;
  readonly names: readonly string[];
  readonly root: PsbValue;
  private readonly data: ByteView;
  private readonly strings: readonly string[];
  private readonly chunks: readonly {offset: number; length: number}[];
  private readonly extras: readonly {offset: number; length: number}[];
  private readonly resources = new Map<number, PsbResource>();

  constructor(bytes: Uint8Array, key?: number) {
    const data = (this.data = new ByteView(bytes, {littleEndian: true}));
    if (data.ascii(0, 4) !== 'PSB\0') throw Error('Not a PSB file');
    this.version = data.u16(4);
    if (this.version < 2 || this.version > 4)
      throw Error(`Unsupported PSB version ${this.version}`);
    const flags = data.u16(6),
      headerEnd = this.version >= 4 ? 0x38 : 0x2c,
      header = data.range(0, headerEnd).slice();
    if (flags & ~1) throw Error(`Unsupported PSB filter flags ${flags}`);
    if (flags & 1) {
      if (key === undefined) throw Error('PSB header filter key is unknown');
      applyPsbKeystream(key, header.subarray(8));
    }
    const field = new ByteView(header, {littleEndian: true}),
      u32 = (offset: number) => field.u32(offset);
    const charset = this.intArray(u32(12)),
      tree = this.intArray(charset.end),
      indices = this.intArray(tree.end);
    this.names = indices.values.map((index, i) =>
      decodeName(charset.values, tree.values, index, i),
    );
    const stringData = u32(20),
      utf8 = new TextDecoder('utf-8', {fatal: true});
    this.strings = this.intArray(u32(16)).values.map((offset) =>
      utf8.decode(data.cString(stringData + offset)),
    );
    const table = (offsets: number, lengths: number, base: number) => {
      const o = this.intArray(u32(offsets)).values,
        l = this.intArray(u32(lengths)).values;
      if (o.length !== l.length) throw Error('PSB resource tables differ in length');
      return o.map((offset, i) => {
        data.check(u32(base) + offset, l[i]!);
        return {offset: u32(base) + offset, length: l[i]!};
      });
    };
    this.chunks = table(24, 28, 32);
    this.extras = this.version >= 4 ? table(0x2c, 0x30, 0x34) : [];
    this.root = this.value(u32(36));
  }

  private resource(index: number, extra: boolean): PsbResource {
    const key = extra ? -1 - index : index;
    let resource = this.resources.get(key);
    if (!resource) {
      const chunk = (extra ? this.extras : this.chunks)[index];
      if (!chunk) throw Error(`PSB resource ${index} out of range`);
      resource = new PsbResource(index, extra, this.data.range(chunk.offset, chunk.length));
      this.resources.set(key, resource);
    }
    return resource;
  }

  private value(offset: number): PsbValue {
    const data = this.data,
      type = data.u8(offset);
    if (type === 0x01) return null;
    if (type === 0x02) return false;
    if (type === 0x03) return true;
    if (type === 0x04 || type === 0x1d) return 0;
    if (type >= 0x05 && type <= 0x0c) return this.signed(offset + 1, type - 0x04);
    if (type >= 0x0d && type <= 0x14) return this.intArray(offset).values;
    if (type >= 0x15 && type <= 0x18) {
      const value = this.strings[this.unsigned(offset + 1, type - 0x14)];
      if (value === undefined) throw Error(`PSB string out of range at ${offset}`);
      return value;
    }
    if (type >= 0x19 && type <= 0x1c)
      return this.resource(this.unsigned(offset + 1, type - 0x18), false);
    if (type === 0x1e) return data.f32(offset + 1);
    if (type === 0x1f) return data.f64(offset + 1);
    if (type === 0x20) {
      const offsets = this.intArray(offset + 1);
      return offsets.values.map((relative) => this.value(offsets.end + relative));
    }
    if (type === 0x21) {
      const keys = this.intArray(offset + 1),
        offsets = this.intArray(keys.end),
        object: PsbObject = Object.create(null);
      if (keys.values.length !== offsets.values.length)
        throw Error(`PSB object at ${offset}: key and value counts differ`);
      keys.values.forEach((key, i) => {
        const name = this.names[key];
        if (name === undefined) throw Error(`PSB name ${key} out of range`);
        object[name] = this.value(offsets.end + offsets.values[i]!);
      });
      return object;
    }
    if (type >= 0x22 && type <= 0x25 && this.version >= 4)
      return this.resource(this.unsigned(offset + 1, type - 0x21), true);
    throw Error(`Unsupported PSB value type 0x${type.toString(16)} at ${offset}`);
  }

  /** An integer array (`0x0d`-`0x14`): count width, count, element width, elements. */
  private intArray(offset: number): {values: number[]; end: number} {
    const type = this.data.u8(offset);
    if (type < 0x0d || type > 0x14)
      throw Error(`Expected PSB integer array at ${offset}, found 0x${type.toString(16)}`);
    const countWidth = type - 0x0c,
      count = this.unsigned(offset + 1, countWidth),
      width = this.data.u8(offset + 1 + countWidth) - 0x0c,
      start = offset + 2 + countWidth;
    if (width < 1 || width > 8) throw Error(`Invalid PSB array element width at ${offset}`);
    this.data.check(start, count * width);
    const values = new Array<number>(count);
    for (let i = 0; i < count; i++) values[i] = this.unsigned(start + i * width, width);
    return {values, end: start + count * width};
  }

  private unsigned(offset: number, width: number): number {
    const bytes = this.data.range(offset, width);
    let value = 0;
    for (let i = width - 1; i >= 0; i--) value = value * 256 + bytes[i]!;
    if (!Number.isSafeInteger(value)) throw Error(`PSB integer at ${offset} exceeds 2^53`);
    return value;
  }

  private signed(offset: number, width: number): number {
    const bytes = this.data.range(offset, width);
    let value = 0n;
    for (let i = width - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]!);
    value = BigInt.asIntN(width * 8, value);
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER))
      throw Error(`PSB integer at ${offset} exceeds 2^53`);
    return Number(value);
  }
}

/**
 * Walks from the terminal node of name `i` to the trie root. Each node's tree entry is its
 * parent, and its character is the node index minus the parent's charset base.
 */
function decodeName(
  charset: readonly number[],
  tree: readonly number[],
  index: number,
  i: number,
): string {
  const out: number[] = [];
  let node = tree[index];
  for (let guard = 0; node !== 0; guard++) {
    if (node === undefined || guard > tree.length) throw Error(`PSB name ${i} is malformed`);
    const parent = tree[node],
      base = parent === undefined ? undefined : charset[parent];
    if (parent === undefined || base === undefined) throw Error(`PSB name ${i} is malformed`);
    out.push(node - base);
    node = parent;
  }
  return new TextDecoder('utf-8', {fatal: true}).decode(Uint8Array.from(out.reverse()));
}

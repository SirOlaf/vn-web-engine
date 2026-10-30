import {ByteView} from '../../core/binary.js';
import {applyPsbKeystream, emoteDriverImage, EMOTE_DRIVER_X64_SHA256} from './psb-filter.js';

/** A resource chunk referenced from the tree. */
export class PsbResource {
  readonly bytes: Uint8Array;
  /** Present on the x64 resource layout; ordinary resources have false. */
  declare readonly extra?: boolean;
  constructor(index: number, bytes: Uint8Array);
  constructor(index: number, extra: boolean, bytes: Uint8Array);
  constructor(
    readonly index: number,
    bytesOrExtra: Uint8Array | boolean,
    bytes?: Uint8Array,
  ) {
    this.bytes = typeof bytesOrExtra === 'boolean' ? bytes! : bytesOrExtra;
    if (typeof bytesOrExtra === 'boolean')
      Object.defineProperty(this, 'extra', {value: bytesOrExtra, enumerable: true});
  }
}
export type PsbValue =
  null | boolean | number | bigint | string | PsbResource | readonly PsbValue[] | PsbObject;
export interface PsbObject {
  readonly [key: string]: PsbValue;
}

export interface PsbReadOptions {
  readonly driverSha256?: string;
  /** Header-filter key; a filtered x64 header requires an explicitly supplied key. */
  readonly headerKey?: number;
}

/**
 * PSB ("packed struct binary", M2 / E-mote) tree reader. Covers the unencrypted header layout
 * of versions 2 to 4 and the value types those files use for scenarios (`.scn`) and E-mote
 * data. The exact x64 E-mote image enables filtered headers, version-4 extra chunks,
 * shared resource identity and its safe-integer policy. E-mote files carry a body
 * filter that `decryptPsbBody` (psb-filter.ts) removes first.
 *
 * Layout: names are stored as a double-array trie (charset, tree, name indices); strings as an
 * offset table into NUL-terminated UTF-8; resources as offset and length tables into a data
 * area; the root is a value at a header offset.
 */
export class PsbFile {
  readonly version: number;
  readonly names: readonly string[];
  private readonly data: ByteView;
  private readonly stringOffsets: readonly number[];
  private readonly stringData: number;
  private readonly chunkOffsets: readonly number[];
  private readonly chunkLengths: readonly number[];
  private readonly chunkData: number;
  private readonly rootOffset: number;
  private readonly x64: boolean;
  private readonly extraOffsets: readonly number[];
  private readonly extraLengths: readonly number[];
  private readonly extraData: number;
  private readonly resources = new Map<number, PsbResource>();
  private readonly parsedRoot: PsbValue | undefined;
  private readonly strings = new Map<number, string>();
  private readonly utf8 = new TextDecoder('utf-8', {fatal: true});

  constructor(
    readonly bytes: Uint8Array,
    options: PsbReadOptions = {},
  ) {
    this.x64 = emoteDriverImage(options.driverSha256) === EMOTE_DRIVER_X64_SHA256;
    const data = (this.data = new ByteView(bytes, {littleEndian: true}));
    if (data.ascii(0, 4) !== 'PSB\0') throw new Error('Not a PSB file');
    this.version = data.u16(4);
    if (this.version < 2 || this.version > 4)
      throw new Error(`Unsupported PSB version ${this.version}`);
    const flags = data.u16(6);
    let fields = data;
    if (this.x64) {
      const header = data.range(0, this.version >= 4 ? 0x38 : 0x2c).slice();
      if (flags & ~1) throw Error(`Unsupported PSB filter flags ${flags}`);
      if (flags & 1) {
        if (options.headerKey === undefined) throw Error('PSB header filter key is unknown');
        applyPsbKeystream(options.headerKey, header.subarray(8));
      }
      fields = new ByteView(header, {littleEndian: true});
    } else if (flags) throw new Error('Encrypted PSB headers are not supported');
    const names = fields.u32(12);
    this.stringOffsets = this.intArray(fields.u32(16)).values;
    this.stringData = fields.u32(20);
    this.chunkOffsets = this.intArray(fields.u32(24)).values;
    this.chunkLengths = this.intArray(fields.u32(28)).values;
    this.chunkData = fields.u32(32);
    this.rootOffset = fields.u32(36);
    this.extraOffsets = this.x64 && this.version >= 4 ? this.intArray(fields.u32(0x2c)).values : [];
    this.extraLengths = this.x64 && this.version >= 4 ? this.intArray(fields.u32(0x30)).values : [];
    this.extraData = this.x64 && this.version >= 4 ? fields.u32(0x34) : 0;
    const charset = this.intArray(names),
      tree = this.intArray(charset.end),
      indices = this.intArray(tree.end);
    this.names = indices.values.map((index, i) =>
      decodeName(charset.values, tree.values, index, i),
    );
    if (this.x64) {
      for (let i = 0; i < this.stringOffsets.length; i++) this.string(i);
      for (const [offsets, lengths, base] of [
        [this.chunkOffsets, this.chunkLengths, this.chunkData],
        [this.extraOffsets, this.extraLengths, this.extraData],
      ] as const) {
        if (offsets.length !== lengths.length) throw Error('PSB resource tables differ in length');
        offsets.forEach((offset, index) => data.check(base + offset, lengths[index]!));
      }
      this.parsedRoot = this.value(this.rootOffset);
    }
  }

  get root(): PsbValue {
    return this.x64 ? this.parsedRoot! : this.value(this.rootOffset);
  }

  resource(index: number, extra = false): PsbResource {
    if (!Number.isSafeInteger(index) || index < 0)
      throw Error(`PSB resource ${index} out of range`);
    const key = extra ? -1 - index : index;
    if (this.x64) {
      const cached = this.resources.get(key);
      if (cached) return cached;
    }
    const offset = (extra ? this.extraOffsets : this.chunkOffsets)[index],
      length = (extra ? this.extraLengths : this.chunkLengths)[index];
    if (offset === undefined || length === undefined)
      throw new Error(`PSB resource ${index} out of range`);
    const bytes = this.data.range((extra ? this.extraData : this.chunkData) + offset, length);
    const resource = this.x64
      ? new PsbResource(index, extra, bytes)
      : new PsbResource(index, bytes);
    if (this.x64) this.resources.set(key, resource);
    return resource;
  }

  string(index: number): string {
    let value = this.strings.get(index);
    if (value === undefined) {
      const offset = this.stringOffsets[index];
      if (offset === undefined) throw new Error(`PSB string ${index} out of range`);
      value = this.utf8.decode(this.data.cString(this.stringData + offset));
      this.strings.set(index, value);
    }
    return value;
  }

  /** Decodes the value at byte `offset`. */
  value(offset: number): PsbValue {
    const data = this.data,
      type = data.u8(offset);
    if (type === 0x01) return null;
    if (type === 0x02) return false;
    if (type === 0x03) return true;
    if (type === 0x04) return 0;
    if (type >= 0x05 && type <= 0x0c) return this.signed(offset + 1, type - 0x04);
    if (type >= 0x0d && type <= 0x14) return this.intArray(offset).values;
    if (type >= 0x15 && type <= 0x18) {
      const index = this.unsigned(offset + 1, type - 0x14);
      if (this.x64 && this.stringOffsets[index] === undefined)
        throw Error(`PSB string out of range at ${offset}`);
      return this.string(index);
    }
    if (type >= 0x19 && type <= 0x1c) return this.resource(this.unsigned(offset + 1, type - 0x18));
    if (type === 0x1d) return 0;
    if (type === 0x1e) return data.f32(offset + 1);
    if (type === 0x1f) return data.f64(offset + 1);
    if (type === 0x20) {
      const offsets = this.intArray(offset + 1);
      return offsets.values.map((relative) => this.value(offsets.end + relative));
    }
    if (type === 0x21) {
      const keys = this.intArray(offset + 1),
        offsets = this.intArray(keys.end),
        object: Record<string, PsbValue> = Object.create(null);
      if (keys.values.length !== offsets.values.length)
        throw new Error(`PSB object at ${offset}: key and value counts differ`);
      keys.values.forEach((key, i) => {
        const name = this.names[key];
        if (name === undefined) throw new Error(`PSB name ${key} out of range`);
        object[name] = this.value(offsets.end + offsets.values[i]!);
      });
      return object;
    }
    if (this.x64 && type >= 0x22 && type <= 0x25 && this.version >= 4)
      return this.resource(this.unsigned(offset + 1, type - 0x21), true);
    throw new Error(`Unsupported PSB value type 0x${type.toString(16)} at ${offset}`);
  }

  /** An integer array (`0x0d`-`0x14`): count width, count, element width, elements. */
  private intArray(offset: number): {values: number[]; end: number} {
    const type = this.data.u8(offset);
    if (type < 0x0d || type > 0x14)
      throw new Error(`Expected PSB integer array at ${offset}, found 0x${type.toString(16)}`);
    const countWidth = type - 0x0c,
      count = this.unsigned(offset + 1, countWidth),
      widthType = this.data.u8(offset + 1 + countWidth),
      width = widthType - 0x0c,
      start = offset + 2 + countWidth;
    if (width < 1 || width > 8) throw new Error(`Invalid PSB array element width at ${offset}`);
    this.data.check(start, count * width);
    const values = new Array<number>(count);
    for (let i = 0; i < count; i++) values[i] = this.unsigned(start + i * width, width);
    return {values, end: start + count * width};
  }

  private unsigned(offset: number, width: number): number {
    const bytes = this.data.range(offset, width);
    let value = 0;
    for (let i = width - 1; i >= 0; i--) value = value * 256 + bytes[i]!;
    if (!Number.isSafeInteger(value)) throw new Error(`PSB integer at ${offset} exceeds 2^53`);
    return value;
  }

  private signed(offset: number, width: number): number | bigint {
    const bytes = this.data.range(offset, width);
    let value = 0n;
    for (let i = width - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]!);
    value = BigInt.asIntN(width * 8, value);
    if (
      this.x64 &&
      (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER))
    )
      throw Error(`PSB integer at ${offset} exceeds 2^53`);
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value;
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
    if (node === undefined || guard > tree.length) throw new Error(`PSB name ${i} is malformed`);
    const parent = tree[node],
      base = parent === undefined ? undefined : charset[parent];
    if (parent === undefined || base === undefined) throw new Error(`PSB name ${i} is malformed`);
    out.push(node - base);
    node = parent;
  }
  return new TextDecoder('utf-8', {fatal: true}).decode(Uint8Array.from(out.reverse()));
}

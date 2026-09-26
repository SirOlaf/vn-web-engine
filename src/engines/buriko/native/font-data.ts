/** Font tables are read only from user-provided resources; no font data is bundled. */
export interface BurikoFontName {
  readonly platform: number;
  readonly encoding: number;
  readonly language: number;
  readonly id: number;
  readonly bytes: Uint8Array;
  readonly unicode: string | null;
}

export interface BurikoFontData {
  /** A standalone sfnt, including a rebuilt directory for a collection member. */
  readonly bytes: Uint8Array;
  readonly names: readonly BurikoFontName[];
  readonly unitsPerEm: number;
  readonly winAscent: number;
  readonly winDescent: number;
  readonly averageWidth: number | null;
  readonly weight: number;
  readonly italic: boolean;
  readonly fixedPitch: boolean;
  readonly codePageRanges: readonly [number, number] | null;
}

class FontReader {
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  range(offset: number, length: number): Uint8Array {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > this.bytes.length
    )
      throw new RangeError('Buriko font table exceeds supplied resource');
    return this.bytes.subarray(offset, offset + length);
  }
  u16(offset: number): number {
    this.range(offset, 2);
    return this.view.getUint16(offset);
  }
  i16(offset: number): number {
    this.range(offset, 2);
    return this.view.getInt16(offset);
  }
  u32(offset: number): number {
    this.range(offset, 4);
    return this.view.getUint32(offset);
  }
}

interface Table {
  readonly tag: number;
  readonly bytes: Uint8Array;
}
const tags = {
  head: 0x68656164,
  hhea: 0x68686561,
  os2: 0x4f532f32,
  name: 0x6e616d65,
  post: 0x706f7374,
} as const;

function checksum(bytes: Uint8Array): number {
  let sum = 0;
  for (let offset = 0; offset < bytes.length; offset += 4)
    sum =
      (sum +
        (((bytes[offset] ?? 0) << 24) |
          ((bytes[offset + 1] ?? 0) << 16) |
          ((bytes[offset + 2] ?? 0) << 8) |
          (bytes[offset + 3] ?? 0))) >>>
      0;
  return sum;
}

function standalone(signature: number, tables: readonly Table[]): Uint8Array {
  const sorted = [...tables].sort((a, b) => a.tag - b.tag);
  let length = 12 + sorted.length * 16;
  for (const table of sorted) length += Math.ceil(table.bytes.length / 4) * 4;
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  const exponent = Math.floor(Math.log2(sorted.length));
  view.setUint32(0, signature);
  view.setUint16(4, sorted.length);
  view.setUint16(6, 16 * 2 ** exponent);
  view.setUint16(8, exponent);
  view.setUint16(10, sorted.length * 16 - 16 * 2 ** exponent);
  let offset = 12 + sorted.length * 16;
  let headOffset: number | null = null;
  sorted.forEach((table, index) => {
    const directory = 12 + index * 16;
    bytes.set(table.bytes, offset);
    if (table.tag === tags.head) {
      if (table.bytes.length < 12) throw new RangeError('Buriko font head table is truncated');
      headOffset = offset;
      view.setUint32(offset + 8, 0);
    }
    view.setUint32(directory, table.tag);
    view.setUint32(directory + 4, checksum(bytes.subarray(offset, offset + table.bytes.length)));
    view.setUint32(directory + 8, offset);
    view.setUint32(directory + 12, table.bytes.length);
    offset += Math.ceil(table.bytes.length / 4) * 4;
  });
  if (headOffset !== null) view.setUint32(headOffset + 8, (0xb1b0afba - checksum(bytes)) >>> 0);
  return bytes;
}

function names(table: FontReader): BurikoFontName[] {
  const version = table.u16(0);
  if (version > 1) throw new RangeError('Buriko font naming table version is invalid');
  const count = table.u16(2);
  const stringOffset = table.u16(4);
  table.range(6, count * 12);
  if (version === 1) {
    const languageCount = table.u16(6 + count * 12);
    table.range(8 + count * 12, languageCount * 4);
    for (let index = 0; index < languageCount; index++) {
      const record = 8 + count * 12 + index * 4;
      table.range(stringOffset + table.u16(record + 2), table.u16(record));
    }
  }
  const result: BurikoFontName[] = [];
  for (let index = 0; index < count; index++) {
    const record = 6 + index * 12;
    const platform = table.u16(record);
    const encoding = table.u16(record + 2);
    const bytes = table.range(stringOffset + table.u16(record + 10), table.u16(record + 8));
    let unicode: string | null = null;
    if (
      platform === 0 ||
      (platform === 3 && (encoding === 0 || encoding === 1 || encoding === 10))
    ) {
      if (bytes.length & 1) throw new RangeError('Buriko font UTF-16 name has odd length');
      unicode = '';
      for (let offset = 0; offset < bytes.length; offset += 2)
        unicode += String.fromCharCode((bytes[offset]! << 8) | bytes[offset + 1]!);
    } else if (platform === 1 && encoding === 0) {
      unicode = new TextDecoder('macintosh', {ignoreBOM: true}).decode(bytes);
    }
    result.push({
      platform,
      encoding,
      language: table.u16(record + 4),
      id: table.u16(record + 6),
      bytes: bytes.slice(),
      unicode,
    });
  }
  return result;
}

function face(reader: FontReader, directoryOffset: number, collection: boolean): BurikoFontData {
  const signature = reader.u32(directoryOffset);
  if (
    signature !== 0x00010000 &&
    signature !== 0x4f54544f &&
    signature !== 0x74727565 &&
    signature !== 0x74797031
  )
    throw new RangeError('Buriko font sfnt signature is invalid');
  const count = reader.u16(directoryOffset + 4);
  if (count === 0) throw new RangeError('Buriko font has no tables');
  reader.range(directoryOffset + 12, count * 16);
  const tables: Table[] = [];
  const map = new Map<number, FontReader>();
  for (let index = 0; index < count; index++) {
    const offset = directoryOffset + 12 + index * 16;
    const tag = reader.u32(offset);
    if (map.has(tag)) throw new RangeError('Buriko font contains duplicate tables');
    const bytes = reader.range(reader.u32(offset + 8), reader.u32(offset + 12));
    map.set(tag, new FontReader(bytes));
    tables.push({tag, bytes});
  }
  const head = map.get(tags.head);
  const hhea = map.get(tags.hhea);
  const os2 = map.get(tags.os2);
  const name = map.get(tags.name);
  const post = map.get(tags.post);
  if (!head || !hhea || !name)
    throw new RangeError('Buriko font lacks required metric/name tables');
  if (head.u32(0) !== 0x00010000 || hhea.u32(0) !== 0x00010000 || head.u32(12) !== 0x5f0f3cf5)
    throw new RangeError('Buriko font metric table version/signature is invalid');
  const unitsPerEm = head.u16(18);
  if (unitsPerEm < 16 || unitsPerEm > 16384)
    throw new RangeError('Buriko font units per em is invalid');
  // Windows metrics are separate from CSS typographic ascent/descent.
  const winAscent = os2 && os2.bytes.length >= 78 ? os2.u16(74) : head.i16(42);
  const winDescent = os2 && os2.bytes.length >= 78 ? os2.u16(76) : -head.i16(38);
  return {
    bytes: collection ? standalone(signature, tables) : reader.bytes.slice(),
    names: names(name),
    unitsPerEm,
    winAscent,
    winDescent,
    averageWidth: os2 ? os2.i16(2) : null,
    weight: os2 ? os2.u16(4) : head.u16(44) & 1 ? 700 : 400,
    italic: os2 ? (os2.u16(62) & 1) !== 0 : (head.u16(44) & 2) !== 0,
    fixedPitch: post ? post.u32(12) !== 0 : false,
    codePageRanges:
      os2 && os2.u16(0) >= 1 && os2.bytes.length >= 86 ? [os2.u32(78), os2.u32(82)] : null,
  };
}

/** sfnt and TTC/OTC share the same directory; TTC table offsets remain file-relative. */
export function readBurikoFontData(bytes: Uint8Array): readonly BurikoFontData[] {
  const reader = new FontReader(bytes);
  if (reader.u32(0) !== 0x74746366) return [face(reader, 0, false)];
  const version = reader.u32(4);
  if (version !== 0x00010000 && version !== 0x00020000)
    throw new RangeError('Buriko font collection version is invalid');
  const count = reader.u32(8);
  if (count === 0) throw new RangeError('Buriko font collection is empty');
  reader.range(12, count * 4);
  if (version === 0x00020000) reader.range(12 + count * 4, 12);
  return Array.from({length: count}, (_, index) => face(reader, reader.u32(12 + index * 4), true));
}

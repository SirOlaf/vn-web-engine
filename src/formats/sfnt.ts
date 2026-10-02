import {ByteView} from '../core/binary.js';
import type {ByteSource} from '../core/source.js';

/** Font tables are read only from user-provided resources; no font data is bundled. */
export interface SfntFontName {
  readonly platform: number;
  readonly encoding: number;
  readonly language: number;
  readonly id: number;
  readonly bytes: Uint8Array;
  readonly unicode: string | null;
}

export interface SfntFontMetadata {
  readonly names: readonly SfntFontName[];
  readonly unitsPerEm: number;
  readonly winAscent: number;
  readonly winDescent: number;
  readonly averageWidth: number | null;
  readonly weight: number;
  readonly italic: boolean;
  readonly fixedPitch: boolean;
  readonly codePageRanges: readonly [number, number] | null;
}

export interface SfntFontData extends SfntFontMetadata {
  /** A standalone sfnt, including a rebuilt directory for a collection member. */
  readonly bytes: Uint8Array;
}

function fontRange(size: number, offset: number, length: number): void {
  if (
    !Number.isSafeInteger(size) ||
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > size - length
  )
    throw new RangeError('Font table exceeds supplied resource');
}

function fontView(bytes: Uint8Array): ByteView {
  return new ByteView(bytes, {error: () => new RangeError('Font table exceeds supplied resource')});
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
      if (table.bytes.length < 12) throw new RangeError('Font head table is truncated');
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

function names(table: ByteView): SfntFontName[] {
  const version = table.u16(0);
  if (version > 1) throw new RangeError('Font naming table version is invalid');
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
  const result: SfntFontName[] = [];
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
      if (bytes.length & 1) throw new RangeError('Font UTF-16 name has odd length');
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
      bytes: new Uint8Array(bytes),
      unicode,
    });
  }
  return result;
}

interface TableRange {
  readonly tag: number;
  readonly offset: number;
  readonly length: number;
}

function faceHeader(header: ByteView): {signature: number; count: number} {
  const signature = header.u32(0);
  if (
    signature !== 0x00010000 &&
    signature !== 0x4f54544f &&
    signature !== 0x74727565 &&
    signature !== 0x74797031
  )
    throw new RangeError('Font sfnt signature is invalid');
  const count = header.u16(4);
  if (count === 0) throw new RangeError('Font has no tables');
  return {signature, count};
}

function tableDirectory(reader: ByteView, count: number, size: number): TableRange[] {
  reader.range(0, count * 16);
  const result: TableRange[] = [];
  const seen = new Set<number>();
  for (let index = 0; index < count; index++) {
    const record = index * 16;
    const tag = reader.u32(record);
    if (seen.has(tag)) throw new RangeError('Font contains duplicate tables');
    seen.add(tag);
    const offset = reader.u32(record + 8),
      length = reader.u32(record + 12);
    fontRange(size, offset, length);
    result.push({tag, offset, length});
  }
  return result;
}

function metadata(map: ReadonlyMap<number, ByteView>): SfntFontMetadata {
  const head = map.get(tags.head);
  const hhea = map.get(tags.hhea);
  const os2 = map.get(tags.os2);
  const name = map.get(tags.name);
  const post = map.get(tags.post);
  if (!head || !hhea || !name) throw new RangeError('Font lacks required metric/name tables');
  if (head.u32(0) !== 0x00010000 || hhea.u32(0) !== 0x00010000 || head.u32(12) !== 0x5f0f3cf5)
    throw new RangeError('Font metric table version/signature is invalid');
  const unitsPerEm = head.u16(18);
  if (unitsPerEm < 16 || unitsPerEm > 16384) throw new RangeError('Font units per em is invalid');
  // Windows metrics are separate from CSS typographic ascent/descent.
  const winAscent = os2 && os2.bytes.length >= 78 ? os2.u16(74) : head.i16(42);
  const winDescent = os2 && os2.bytes.length >= 78 ? os2.u16(76) : -head.i16(38);
  return {
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

function face(reader: ByteView, directoryOffset: number, collection: boolean): SfntFontData {
  const {signature, count} = faceHeader(reader.sub(directoryOffset, 12));
  const directory = tableDirectory(
    reader.sub(directoryOffset + 12, count * 16),
    count,
    reader.bytes.length,
  );
  const tables = directory.map(({tag, offset, length}) => ({
    tag,
    bytes: reader.range(offset, length),
  }));
  const map = new Map(tables.map(({tag, bytes}) => [tag, fontView(bytes)]));
  const data = metadata(map);
  return {...data, bytes: collection ? standalone(signature, tables) : reader.bytes.slice()};
}

function collectionCount(reader: ByteView, size: number): number | null {
  if (reader.u32(0) !== 0x74746366) return null;
  const version = reader.u32(4);
  if (version !== 0x00010000 && version !== 0x00020000)
    throw new RangeError('Font collection version is invalid');
  const count = reader.u32(8);
  if (count === 0) throw new RangeError('Font collection is empty');
  fontRange(size, 12, count * 4);
  if (version === 0x00020000) fontRange(size, 12 + count * 4, 12);
  return count;
}

/** sfnt and TTC/OTC share the same directory; TTC table offsets remain file-relative. */
export function readSfntFontData(bytes: Uint8Array): readonly SfntFontData[] {
  const reader = fontView(bytes);
  const count = collectionCount(reader, bytes.length);
  if (count === null) return [face(reader, 0, false)];
  return Array.from({length: count}, (_, index) => face(reader, reader.u32(12 + index * 4), true));
}

async function sourceReader(source: ByteSource, offset: number, length: number): Promise<ByteView> {
  fontRange(source.size, offset, length);
  const bytes = await source.read(offset, length);
  if (bytes.length !== length) throw new RangeError('Font source returned a truncated range');
  return fontView(bytes);
}

/** Needed tables separated by fewer skipped bytes than this share one source read. */
const METADATA_READ_GAP = 0x1000;

/**
 * Merges reads of nearby metadata tables. A merged read never extends past the needed
 * tables it covers, and each covered range keeps the bounds and truncation checks of a
 * direct read.
 */
class MetadataSource implements ByteSource {
  private readonly spans: {offset: number; end: number; bytes: Promise<Uint8Array>}[] = [];
  constructor(private readonly source: ByteSource) {}
  get size(): number {
    return this.source.size;
  }
  /** Starts one read per cluster of nearby ranges; later reads inside a cluster reuse it. */
  prefetch(ranges: readonly {offset: number; length: number}[]): void {
    const sorted = ranges
      .filter(
        ({offset, length}) =>
          !this.spans.some((s) => offset >= s.offset && offset + length <= s.end),
      )
      .sort((a, b) => a.offset - b.offset);
    let start = -1,
      end = -1,
      members = 0;
    const flush = () => {
      // A lone range reads directly, exactly as without merging.
      if (members < 2) return;
      const bytes = this.source.read(start, end - start);
      // A failed span surfaces when a covered table is read; faces that stop earlier ignore it.
      bytes.catch(() => undefined);
      this.spans.push({offset: start, end, bytes});
    };
    for (const {offset, length} of sorted) {
      if (members > 0 && offset - end < METADATA_READ_GAP) {
        end = Math.max(end, offset + length);
        members++;
      } else {
        flush();
        start = offset;
        end = offset + length;
        members = 1;
      }
    }
    flush();
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    for (const span of this.spans)
      if (offset >= span.offset && offset + length <= span.end)
        return clipped(await span.bytes, offset - span.offset, length);
    return this.source.read(offset, length);
  }
}

/** A short underlying read stays short, so sourceReader reports the same truncation. */
function clipped(bytes: Uint8Array, offset: number, length: number): Uint8Array {
  return bytes.subarray(Math.min(offset, bytes.length), Math.min(offset + length, bytes.length));
}

async function faceMetadata(
  source: ByteSource,
  directoryOffset: number,
  header?: ByteView,
): Promise<SfntFontMetadata> {
  const {count} = faceHeader(header ?? (await sourceReader(source, directoryOffset, 12)));
  const directory = tableDirectory(
    await sourceReader(source, directoryOffset + 12, count * 16),
    count,
    source.size,
  );
  const needed = directory.flatMap(({tag, offset, length}) => {
    const bytes = metadataTableBytes(tag, length);
    return bytes === null ? [] : [{tag, offset, length: Math.min(length, bytes)}];
  });
  if (source instanceof MetadataSource) source.prefetch(needed);
  const map = new Map<number, ByteView>();
  for (const {tag, offset, length} of needed)
    map.set(tag, await sourceReader(source, offset, length));
  return metadata(map);
}

function metadataTableBytes(tag: number, length: number): number | null {
  switch (tag) {
    case tags.head:
      return 46;
    case tags.hhea:
      return 4;
    case tags.os2:
      return 86;
    case tags.name:
      return length;
    case tags.post:
      return 16;
    default:
      return null;
  }
}

/**
 * Read names and metrics without loading glyphs or rebuilding collection members.
 * Table ranges are validated against the complete source, including tables whose
 * contents are not needed. Returned name bytes own their storage.
 */
export async function readSfntFontMetadata(
  input: ByteSource,
): Promise<readonly SfntFontMetadata[]> {
  const source = new MetadataSource(input);
  const header = await sourceReader(source, 0, 12);
  const count = collectionCount(header, source.size);
  if (count === null) return [await faceMetadata(source, 0, header)];
  const offsets = await sourceReader(source, 12, count * 4);
  const result: SfntFontMetadata[] = [];
  for (let index = 0; index < count; index++)
    result.push(await faceMetadata(source, offsets.u32(index * 4)));
  return result;
}

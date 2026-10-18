import {ByteView, checkRange, safeNumber} from '../../core/binary.js';
import {inflateZlib} from '../../core/inflate.js';
import type {ByteSource} from '../../core/source.js';

/** `XP3\r\n \n\x1a\x8b\x67\x01` */
export const XP3_MARK = Uint8Array.of(
  0x58,
  0x50,
  0x33,
  0x0d,
  0x0a,
  0x20,
  0x0a,
  0x1a,
  0x8b,
  0x67,
  0x01,
);
const INDEX_ENCODE_MASK = 0x07,
  INDEX_ENCODE_RAW = 0,
  INDEX_ENCODE_ZLIB = 1,
  INDEX_CONTINUE = 0x80,
  SEGMENT_ENCODE_MASK = 0x07,
  SEGMENT_ENCODE_RAW = 0,
  SEGMENT_ENCODE_ZLIB = 1;
/** `info` flag marking a member its producer asked tools not to extract. */
export const XP3_FILE_PROTECTED = 0x80000000;

export interface Xp3Segment {
  readonly flags: number;
  readonly compressed: boolean;
  /** Absolute offset in the archive source. */
  readonly offset: number;
  readonly size: number;
  readonly storedSize: number;
}
export interface Xp3Entry {
  readonly index: number;
  /** Name as stored in `info`, UTF-16 decoded, not normalized. */
  readonly name: string;
  readonly flags: number;
  readonly size: number;
  readonly storedSize: number;
  readonly segments: readonly Xp3Segment[];
  /** Adler-32 of the stored member contents after any extraction filter. */
  readonly adler32: number | undefined;
  /** Windows FILETIME from the `time` chunk. */
  readonly time: bigint | undefined;
}
/** An index chunk other than `File`, kept for archive-specific readers. */
export interface Xp3Chunk {
  readonly tag: string;
  readonly data: Uint8Array;
}

/** Member lookup key: the core compares member names case-insensitively with `/` separators. */
export function normalizeXp3Name(name: string): string {
  return name.replace(/\\/g, '/').toLowerCase();
}

/**
 * Kirikiri XP3 archive container (index layout of krkr2/krkrz `XP3Archive.cpp`). Supports the
 * version-2 cushion header, chained and zlib-compressed indices and multi-segment members.
 * Extraction filters are applied by the caller on the returned contents.
 */
export class Xp3Archive {
  private readonly byName = new Map<string, Xp3Entry>();
  private constructor(
    readonly source: ByteSource,
    readonly base: number,
    readonly entries: readonly Xp3Entry[],
    readonly chunks: readonly Xp3Chunk[],
  ) {
    for (const entry of entries) {
      const key = normalizeXp3Name(entry.name);
      if (!this.byName.has(key)) this.byName.set(key, entry);
    }
  }

  static async isXp3(source: ByteSource, base = 0): Promise<boolean> {
    if (source.size < base + XP3_MARK.length) return false;
    const mark = await source.read(base, XP3_MARK.length);
    return mark.every((byte, i) => byte === XP3_MARK[i]);
  }

  /** Opens the archive whose mark starts at `base` (non-zero for archives bound to an executable). */
  static async open(source: ByteSource, base = 0): Promise<Xp3Archive> {
    if (!(await Xp3Archive.isXp3(source, base))) throw new Error('Not an XP3 archive');
    const head = new ByteView(await source.read(base + 11, 8), {littleEndian: true});
    let indexOffset = safeNumber(head.u64(0));
    const entries: Xp3Entry[] = [],
      chunks: Xp3Chunk[] = [];
    for (let blocks = 0; ; blocks++) {
      if (blocks > 64) throw new Error('XP3 index chain too long');
      const position = base + indexOffset;
      checkRange(source.size, position, 9);
      const header = new ByteView(
        await source.read(position, Math.min(17, source.size - position)),
        {
          littleEndian: true,
        },
      );
      const flag = header.u8(0);
      let index: Uint8Array, next: number;
      switch (flag & INDEX_ENCODE_MASK) {
        case INDEX_ENCODE_ZLIB: {
          const stored = safeNumber(header.u64(1)),
            size = safeNumber(header.u64(9));
          checkRange(source.size, position + 17, stored);
          index = await inflateZlib(await source.read(position + 17, stored), size);
          next = position + 17 + stored;
          break;
        }
        case INDEX_ENCODE_RAW: {
          const size = safeNumber(header.u64(1));
          checkRange(source.size, position + 9, size);
          index = await source.read(position + 9, size);
          next = position + 9 + size;
          break;
        }
        default:
          throw new Error(`Unknown XP3 index encoding ${flag & INDEX_ENCODE_MASK}`);
      }
      parseIndex(index, base, source.size, entries, chunks);
      if (!(flag & INDEX_CONTINUE)) break;
      checkRange(source.size, next, 8);
      indexOffset = safeNumber(
        new ByteView(await source.read(next, 8), {littleEndian: true}).u64(0),
      );
    }
    return new Xp3Archive(source, base, entries, chunks);
  }

  /** First entry whose normalized name matches, as the core's index lookup does. */
  find(name: string): Xp3Entry | undefined {
    return this.byName.get(normalizeXp3Name(name));
  }

  /** Stored contents of `entry`: segments concatenated and inflated, without extraction filters. */
  async read(entry: Xp3Entry, signal?: AbortSignal): Promise<Uint8Array> {
    const output = new Uint8Array(entry.size);
    let filled = 0;
    for (const segment of entry.segments) {
      const stored = await this.source.read(segment.offset, segment.storedSize, signal);
      const bytes = segment.compressed ? await inflateZlib(stored, segment.size) : stored;
      if (filled + bytes.length > output.length)
        throw new Error(`XP3 member ${entry.name}: segments exceed ${entry.size} bytes`);
      output.set(bytes, filled);
      filled += bytes.length;
    }
    if (filled !== output.length)
      throw new Error(`XP3 member ${entry.name}: segments hold ${filled} of ${entry.size} bytes`);
    return output;
  }
}

function parseIndex(
  index: Uint8Array,
  base: number,
  sourceSize: number,
  entries: Xp3Entry[],
  chunks: Xp3Chunk[],
): void {
  const data = new ByteView(index, {littleEndian: true});
  for (let p = 0; p < index.length;) {
    const tag = data.ascii(p, 4),
      size = safeNumber(data.u64(p + 4)),
      body = data.range(p + 12, size);
    if (tag === 'File') entries.push(parseFile(body, entries.length, base, sourceSize));
    else chunks.push({tag, data: body});
    p += 12 + size;
  }
}

function parseFile(body: Uint8Array, index: number, base: number, sourceSize: number): Xp3Entry {
  const data = new ByteView(body, {littleEndian: true});
  let info: {flags: number; size: number; storedSize: number; name: string} | undefined,
    adler: number | undefined,
    time: bigint | undefined;
  const segments: Xp3Segment[] = [];
  for (let p = 0; p < body.length;) {
    const tag = data.ascii(p, 4),
      size = safeNumber(data.u64(p + 4)),
      start = p + 12,
      end = data.check(start, size) + size;
    switch (tag) {
      case 'info': {
        const length = data.u16(start + 20, end);
        info = {
          flags: data.u32(start, end),
          size: safeNumber(data.u64(start + 4, end)),
          storedSize: safeNumber(data.u64(start + 12, end)),
          name: utf16(data.range(start + 22, length * 2, end)),
        };
        break;
      }
      case 'segm':
        if (size % 28) throw new Error(`XP3 entry ${index}: segm size ${size}`);
        for (let s = start; s < end; s += 28) {
          const flags = data.u32(s, end),
            offset = base + safeNumber(data.u64(s + 4, end)),
            storedSize = safeNumber(data.u64(s + 20, end));
          checkRange(sourceSize, offset, storedSize);
          const encoding = flags & SEGMENT_ENCODE_MASK;
          if (encoding !== SEGMENT_ENCODE_RAW && encoding !== SEGMENT_ENCODE_ZLIB)
            throw new Error(`XP3 entry ${index}: unknown segment encoding ${encoding}`);
          segments.push({
            flags,
            compressed: encoding === SEGMENT_ENCODE_ZLIB,
            offset,
            size: safeNumber(data.u64(s + 12, end)),
            storedSize,
          });
        }
        break;
      case 'adlr':
        adler = data.u32(start, end);
        break;
      case 'time':
        time = data.u64(start, end);
        break;
    }
    p = end;
  }
  if (!info) throw new Error(`XP3 entry ${index}: missing info chunk`);
  return {index, ...info, segments, adler32: adler, time};
}

function utf16(bytes: Uint8Array): string {
  return new TextDecoder('utf-16le').decode(bytes);
}

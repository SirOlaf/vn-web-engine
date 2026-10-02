import {ByteView, checkRange} from '../../core/binary.js';
import {SliceSource, type ByteSource} from '../../core/source.js';

export interface XflEntry {
  readonly index: number;
  readonly name: string;
  /** Absolute offset in the archive source. */
  readonly offset: number;
  readonly size: number;
}

const ENTRY_SIZE = 40;
const NAME_SIZE = 32;

/** ASCII-only case folding; the native lookup uses lstrcmpiA on Shift-JIS names. */
export function xflNameKey(name: string): string {
  return name.replace(/[a-z]/g, (c) => c.toUpperCase());
}

/**
 * codeX RScript `LB` archive (Liar-soft `.xfl`).
 *
 * The native reader (0x43CCB0) checks the `LB` signature and version byte 1, reads
 * `count` 40-byte entries and takes the data base from the file position after the
 * index. The header's index-size field is not consulted. Names are looked up with a
 * case-insensitive binary search (0x43CD50); duplicate folded names are rejected here
 * because such an archive could not be resolved deterministically.
 */
export class XflArchive {
  private readonly byName: ReadonlyMap<string, XflEntry>;
  private constructor(
    readonly source: ByteSource,
    readonly entries: readonly XflEntry[],
  ) {
    const byName = new Map<string, XflEntry>();
    for (const entry of entries) {
      const key = xflNameKey(entry.name);
      if (byName.has(key)) throw new Error(`XFL archive contains duplicate entry ${entry.name}`);
      byName.set(key, entry);
    }
    this.byName = byName;
  }

  static async open(source: ByteSource): Promise<XflArchive> {
    if (source.size < 12) throw new Error('Not an XFL archive');
    const header = await source.read(0, 12);
    if (header[0] !== 0x4c || header[1] !== 0x42 || header[2] !== 1)
      throw new Error('Not an XFL archive');
    const count = new ByteView(header, {littleEndian: true}).u32(8);
    const indexSize = count * ENTRY_SIZE;
    checkRange(source.size, 12, indexSize);
    const index = new ByteView(await source.read(12, indexSize), {littleEndian: true});
    const base = 12 + indexSize;
    const decoder = new TextDecoder('shift-jis', {fatal: true});
    const entries: XflEntry[] = [];
    for (let i = 0; i < count; i++) {
      const p = i * ENTRY_SIZE;
      const name = index.cString(p, NAME_SIZE);
      if (name.length === 0 || name.length === NAME_SIZE)
        throw new Error(`XFL entry ${i}: invalid name`);
      const relative = index.u32(p + 32);
      const size = index.u32(p + 36);
      const offset = base + relative;
      checkRange(source.size, offset, size);
      entries.push({index: i, name: decoder.decode(name), offset, size});
    }
    return new XflArchive(source, entries);
  }

  find(name: string): XflEntry | undefined {
    return this.byName.get(xflNameKey(name));
  }

  entrySource(entry: XflEntry): SliceSource {
    if (this.entries[entry.index] !== entry) throw new Error(`Foreign XFL entry ${entry.name}`);
    return new SliceSource(this.source, entry.offset, entry.size);
  }

  read(entry: XflEntry): Promise<Uint8Array> {
    return this.source.read(entry.offset, entry.size);
  }
}

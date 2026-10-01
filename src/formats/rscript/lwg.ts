import {byteDataView, checkRange} from '../../core/binary.js';
import {SliceSource, type ByteSource} from '../../core/source.js';

export interface LwgEntry {
  readonly index: number;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  /**
   * Format flags the native loader keeps but does not interpret. Image layers hold WCG data
   * (8, and 40 in RScript 1.9 files); empty Photoshop layer-set markers are 56 with no data.
   */
  readonly format: number;
  /** Absolute offset in the LWG source. */
  readonly offset: number;
  readonly size: number;
}

/**
 * codeX RScript `LG` layered image (0x4392F0). A 20-byte header holds the canvas
 * height, width and entry count; each entry has a signed position, a format byte,
 * a data-relative offset and size, and a length-prefixed Shift-JIS name. Names keep
 * their native order and are matched exactly (0x439640).
 */
export class LwgImage {
  private constructor(
    readonly source: ByteSource,
    readonly width: number,
    readonly height: number,
    readonly entries: readonly LwgEntry[],
  ) {}

  static async open(source: ByteSource): Promise<LwgImage> {
    if (source.size < 24) throw new Error('Not an LWG image');
    const header = await source.read(0, 24);
    const view = byteDataView(header);
    if (view.getUint16(0, true) !== 0x474c || view.getUint16(2, true) !== 1)
      throw new Error('Not an LWG image');
    const height = view.getUint32(4, true);
    const width = view.getUint32(8, true);
    const count = view.getUint16(12, true);
    const indexSize = view.getUint32(20, true);
    checkRange(source.size, 24, indexSize + 4);
    const index = await source.read(24, indexSize + 4);
    const data = byteDataView(index);
    const decoder = new TextDecoder('shift-jis', {fatal: true});
    const parsed: Omit<LwgEntry, 'offset'>[] = [];
    const relative: number[] = [];
    let cursor = 0;
    for (let i = 0; i < count; i++) {
      checkRange(indexSize, cursor, 18);
      const nameLength = index[cursor + 17]!;
      checkRange(indexSize, cursor + 18, nameLength);
      parsed.push({
        index: i,
        x: data.getInt32(cursor, true),
        y: data.getInt32(cursor + 4, true),
        format: index[cursor + 8]!,
        size: data.getUint32(cursor + 13, true),
        name: decoder.decode(index.subarray(cursor + 18, cursor + 18 + nameLength)),
      });
      relative.push(data.getUint32(cursor + 9, true));
      cursor += 18 + nameLength;
    }
    if (cursor !== indexSize) throw new Error('LWG index size mismatch');
    const dataSize = data.getUint32(indexSize, true);
    const base = 24 + indexSize + 4;
    checkRange(source.size, base, dataSize);
    const entries = parsed.map((entry, i): LwgEntry => {
      const offset = relative[i]!;
      checkRange(dataSize, offset, entry.size);
      return {...entry, offset: base + offset};
    });
    return new LwgImage(source, width, height, entries);
  }

  find(name: string): LwgEntry | undefined {
    return this.entries.find((entry) => entry.name === name);
  }

  entrySource(entry: LwgEntry): SliceSource {
    if (this.entries[entry.index] !== entry) throw new Error(`Foreign LWG entry ${entry.name}`);
    return new SliceSource(this.source, entry.offset, entry.size);
  }

  read(entry: LwgEntry): Promise<Uint8Array> {
    return this.source.read(entry.offset, entry.size);
  }
}

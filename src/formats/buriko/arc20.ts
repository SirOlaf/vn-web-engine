import {checkRange} from '../../core/binary.js';
import {SliceSource, type ByteSource} from '../../core/source.js';
import {signature, view} from './binary.js';
export interface Arc20Entry {
  readonly index: number;
  readonly name: string;
  readonly nameBytes: Uint8Array;
  readonly offset: number;
  readonly size: number;
  readonly metadata: Uint8Array;
}
/** Index identity deliberately preserves duplicates; this inspector performs no overlay lookup. */
export class Arc20Archive {
  private constructor(
    readonly source: ByteSource,
    readonly entries: readonly Arc20Entry[],
  ) {}
  static async open(source: ByteSource): Promise<Arc20Archive> {
    const header = await source.read(0, 16);
    if (!signature(header, 'BURIKO ARC20')) throw new Error('Not a BURIKO ARC20 archive');
    const count = view(header).getUint32(12, true),
      base = 16 + count * 128;
    checkRange(source.size, 16, count * 128);
    const index = await source.read(16, count * 128),
      data = view(index),
      entries: Arc20Entry[] = [];
    const decoder = new TextDecoder('shift-jis', {fatal: true});
    for (let i = 0; i < count; i++) {
      const p = i * 128,
        field = index.subarray(p, p + 96),
        end = field.indexOf(0);
      if (end < 0) throw new Error(`ARC20 entry ${i}: unterminated name`);
      const offset = base + data.getUint32(p + 96, true),
        size = data.getUint32(p + 100, true);
      checkRange(source.size, offset, size);
      const nameBytes = field.slice(0, end);
      entries.push({
        index: i,
        name: decoder.decode(nameBytes),
        nameBytes,
        offset,
        size,
        metadata: index.slice(p + 104, p + 128),
      });
    }
    return new Arc20Archive(source, entries);
  }
  entrySource(index: number): SliceSource {
    const entry = this.entries[index];
    if (!Number.isInteger(index) || !entry) throw new Error(`Unknown ARC20 index ${index}`);
    return new SliceSource(this.source, entry.offset, entry.size);
  }
  read(index: number): Promise<Uint8Array> {
    const source = this.entrySource(index);
    return source.read(0, source.size);
  }
}

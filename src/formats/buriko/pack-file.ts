import {checkRange} from '../../core/binary.js';
import {SliceSource, type ByteSource} from '../../core/source.js';
import {signature, view} from './binary.js';
import type {Arc20Entry} from './arc20.js';

/** Read-only PackFile index. Duplicate names retain their native first-match order. */
export class PackFileArchive {
  private constructor(
    readonly source: ByteSource,
    readonly entries: readonly Arc20Entry[],
  ) {}

  static async open(source: ByteSource): Promise<PackFileArchive> {
    const header = await source.read(0, 16);
    if (!signature(header, 'PackFile    ')) throw new Error('Not a PackFile archive');
    const count = view(header).getUint32(12, true),
      base = 16 + count * 32;
    checkRange(source.size, 16, count * 32);
    const index = await source.read(16, count * 32),
      data = view(index);
    const decoder = new TextDecoder('shift-jis', {fatal: true});
    const entries: Arc20Entry[] = [];
    for (let i = 0; i < count; i++) {
      const p = i * 32,
        field = index.subarray(p, p + 16),
        end = field.indexOf(0);
      if (end < 0) throw new Error(`PackFile entry ${i}: unterminated name`);
      const offset = base + data.getUint32(p + 16, true),
        size = data.getUint32(p + 20, true);
      checkRange(source.size, offset, size);
      const nameBytes = field.slice(0, end);
      entries.push({
        index: i,
        name: decoder.decode(nameBytes),
        nameBytes,
        offset,
        size,
        metadata: index.slice(p + 24, p + 32),
      });
    }
    return new PackFileArchive(source, entries);
  }

  entrySource(index: number): SliceSource {
    const entry = this.entries[index];
    if (!Number.isInteger(index) || !entry) throw new Error(`Unknown PackFile index ${index}`);
    return new SliceSource(this.source, entry.offset, entry.size);
  }

  read(index: number): Promise<Uint8Array> {
    const source = this.entrySource(index);
    return source.read(0, source.size);
  }
}

import {ByteView, checkRange} from '../../core/binary.js';
import type {ByteSource} from '../../core/source.js';

export interface PfsEntry {
  readonly index: number;
  readonly name: string;
  readonly offset: number;
  readonly size: number;
  readonly metadata: number;
}

/** Native archive keys preserve case and Unicode; only separator spelling changes. */
export function pfsPathKey(name: string): string {
  return name.replace(/\\/g, '/');
}

async function exactRead(source: ByteSource, offset: number, size: number, signal?: AbortSignal) {
  const bytes = await source.read(offset, size, signal);
  if (bytes.length !== size) throw new Error('Truncated PF8 source');
  return bytes;
}

/** PF8 index and lazy XOR payloads. Other PFS revisions are deliberately refused. */
export class PfsArchive {
  private readonly byName = new Map<string, PfsEntry>();
  private constructor(
    readonly source: ByteSource,
    readonly entries: readonly PfsEntry[],
    private readonly key: Uint8Array,
  ) {
    for (const entry of entries) this.byName.set(pfsPathKey(entry.name), entry);
  }

  static async open(source: ByteSource): Promise<PfsArchive> {
    checkRange(source.size, 0, 11);
    const header = await exactRead(source, 0, 11);
    if (header[0] !== 0x70 || header[1] !== 0x66 || header[2] !== 0x38)
      throw new Error('Unsupported PFS signature/revision; expected pf8');
    const indexSize = new ByteView(header, {littleEndian: true}).u32(3);
    checkRange(source.size, 7, indexSize);
    if (indexSize < 4) throw new Error('Invalid PF8 index size');
    const bytes = await exactRead(source, 7, indexSize);
    const view = new ByteView(bytes, {littleEndian: true});
    const count = view.u32(0);
    if (count > Math.floor((indexSize - 4) / 16)) throw new Error('Invalid PF8 entry count');
    const entries: PfsEntry[] = [];
    const decoder = new TextDecoder('utf-8', {fatal: true});
    let p = 4;
    for (let index = 0; index < count; index++) {
      const length = view.u32(p);
      p += 4;
      checkRange(bytes.length, p, length + 12);
      const nameBytes = bytes.subarray(p, p + length);
      if (!length || nameBytes.includes(0)) throw new Error('Invalid PF8 entry name');
      const name = decoder.decode(nameBytes);
      p += length;
      const metadata = view.u32(p),
        offset = view.u32(p + 4),
        size = view.u32(p + 8);
      p += 12;
      checkRange(source.size, offset, size);
      if (size && offset < 7 + indexSize) throw new Error('PF8 payload overlaps index');
      entries.push({index, name, metadata, offset, size});
    }
    // The trailing offset table is part of the key, even though lookup needs only names.
    const key = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes.slice().buffer));
    return new PfsArchive(source, entries, key);
  }

  find(name: string): PfsEntry | undefined {
    return this.byName.get(pfsPathKey(name));
  }

  entrySource(entry: PfsEntry): ByteSource {
    if (this.entries[entry.index] !== entry) throw new Error('Foreign PF8 entry');
    return {
      size: entry.size,
      read: async (offset, length, signal) => {
        checkRange(entry.size, offset, length);
        // A ByteSource may return borrowed storage. Never decrypt it in place.
        const bytes = (await exactRead(this.source, entry.offset + offset, length, signal)).slice();
        for (let i = 0; i < bytes.length; i++) bytes[i] = bytes[i]! ^ this.key[(offset + i) % 20]!;
        return bytes;
      },
    };
  }

  read(entry: PfsEntry): Promise<Uint8Array> {
    return this.entrySource(entry).read(0, entry.size);
  }
}

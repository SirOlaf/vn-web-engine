import {ByteView} from '../../core/binary.js';

export interface PeSection {
  readonly rva: number;
  /** Bytes stored in the file (SizeOfRawData). */
  readonly size: number;
  readonly offset: number;
}

/**
 * The file layout of a PE32 or PE32+ image: its headers, sections and data directories.
 * Addresses map to file offsets only where the file stores them.
 */
export class PeImage {
  private constructor(
    readonly view: ByteView,
    readonly imageBase: bigint,
    readonly headerSize: number,
    readonly sections: readonly PeSection[],
    private readonly directories: readonly {rva: number; size: number}[],
  ) {}

  static parse(bytes: Uint8Array): PeImage {
    if (bytes.length > 512 * 1024 * 1024) throw new Error('PE file exceeds allocation limit');
    const v = new ByteView(bytes, {littleEndian: true});
    v.check(0, 64);
    if (v.u16(0) !== 0x5a4d) throw new Error('Invalid PE DOS signature');
    const pe = v.u32(60);
    v.check(pe, 24);
    if (pe < 64 || v.u32(pe) !== 0x4550) throw new Error('Invalid PE signature');
    const count = v.u16(pe + 6),
      optionalSize = v.u16(pe + 20),
      optional = pe + 24;
    if (!count || count > 96) throw new Error('Invalid PE section count');
    v.check(optional, optionalSize);
    const magic = v.u16(optional),
      directory = magic === 0x10b ? 96 : magic === 0x20b ? 112 : 0;
    if (!directory || optionalSize < directory) throw new Error('Invalid PE optional header');
    const imageBase = magic === 0x10b ? BigInt(v.u32(optional + 28)) : v.u64(optional + 24);
    const directoryCount = v.u32(optional + directory - 4);
    if (directoryCount > Math.floor((optionalSize - directory) / 8))
      throw new Error('Truncated PE data directories');
    const directories = Array.from({length: directoryCount}, (_, i) => ({
      rva: v.u32(optional + directory + i * 8),
      size: v.u32(optional + directory + i * 8 + 4),
    }));
    const headerSize = v.u32(optional + 60),
      table = optional + optionalSize;
    v.check(0, headerSize);
    v.check(table, count * 40, headerSize);
    const sections: PeSection[] = [];
    for (let i = 0; i < count; i++) {
      const p = table + i * 40,
        rva = v.u32(p + 12),
        size = v.u32(p + 16),
        offset = v.u32(p + 20);
      v.check(offset, size);
      if (rva + size > 0x100000000 || (size && offset < headerSize))
        throw new Error('Invalid PE section range');
      sections.push({rva, size, offset});
    }
    const backed = sections.filter((s) => s.size).sort((a, b) => a.rva - b.rva);
    let previousEnd = headerSize;
    for (const s of backed) {
      if (s.rva < previousEnd) throw new Error('Overlapping PE section RVA ranges');
      previousEnd = s.rva + s.size;
    }
    return new PeImage(v, imageBase, headerSize, sections, directories);
  }

  get bytes(): Uint8Array {
    return this.view.bytes;
  }

  /** Data directory `index` (2 is resources), or null when the image has none. */
  directory(index: number): {rva: number; size: number} | null {
    return this.directories[index] ?? null;
  }

  /** File offset of `size` bytes at `rva`; throws unless exactly one stored range holds them. */
  fileOffset(rva: number, size: number): number {
    if (rva + size > 0x100000000) throw new Error('Invalid PE RVA');
    const matches: number[] = [];
    if (rva < this.headerSize && size <= this.headerSize - rva) matches.push(rva);
    for (const s of this.sections) {
      if (rva >= s.rva && rva - s.rva < s.size && size <= s.size - (rva - s.rva))
        matches.push(s.offset + rva - s.rva);
    }
    if (matches.length !== 1) throw new Error('Unmapped or ambiguous PE RVA');
    return matches[0]!;
  }

  /** The zero-terminated string stored at virtual address `address`, without the zero. */
  cString(address: number): Uint8Array {
    const rva = Number(BigInt(address) - this.imageBase);
    const offset = this.fileOffset(rva, 1);
    const section = this.sections.find((s) => offset >= s.offset && offset < s.offset + s.size);
    return this.view.cString(
      offset,
      undefined,
      section ? section.offset + section.size : this.headerSize,
    );
  }
}

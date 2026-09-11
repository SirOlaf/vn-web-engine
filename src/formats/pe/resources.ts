import {checkRange} from '../../core/binary.js';

export type PeResourceId = number | string;
export interface PeResource {
  type: PeResourceId;
  id: PeResourceId;
  language: number;
  codePage: number;
  /** A view into the caller's executable, not a copy. */
  bytes: Uint8Array;
}

/** Read a file-layout PE32/PE32+ resource tree. Does not execute or retain the file. */
export function parsePeResources(bytes: Uint8Array): PeResource[] {
  if (bytes.length > 512 * 1024 * 1024) throw new Error('PE file exceeds allocation limit');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (p: number): number => {
    checkRange(bytes.length, p, 2);
    return v.getUint16(p, true);
  };
  const u32 = (p: number): number => {
    checkRange(bytes.length, p, 4);
    return v.getUint32(p, true);
  };
  checkRange(bytes.length, 0, 64);
  if (u16(0) !== 0x5a4d) throw new Error('Invalid PE DOS signature');
  const pe = u32(60);
  checkRange(bytes.length, pe, 24);
  if (pe < 64 || u32(pe) !== 0x4550) throw new Error('Invalid PE signature');
  const count = u16(pe + 6),
    optionalSize = u16(pe + 20),
    optional = pe + 24;
  if (!count || count > 96) throw new Error('Invalid PE section count');
  checkRange(bytes.length, optional, optionalSize);
  const magic = u16(optional),
    directory = magic === 0x10b ? 96 : magic === 0x20b ? 112 : 0;
  if (!directory || optionalSize < directory) throw new Error('Invalid PE optional header');
  const directoryCount = u32(optional + directory - 4);
  if (directoryCount > Math.floor((optionalSize - directory) / 8))
    throw new Error('Truncated PE data directories');
  const headerSize = u32(optional + 60),
    table = optional + optionalSize;
  checkRange(bytes.length, 0, headerSize);
  checkRange(headerSize, table, count * 40);
  const sections: {rva: number; size: number; offset: number}[] = [];
  for (let i = 0; i < count; i++) {
    const p = table + i * 40,
      rva = u32(p + 12),
      size = u32(p + 16),
      offset = u32(p + 20);
    checkRange(bytes.length, offset, size);
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
  function fileOffset(rva: number, size: number): number {
    if (rva + size > 0x100000000) throw new Error('Invalid PE resource RVA');
    const matches: number[] = [];
    if (rva < headerSize && size <= headerSize - rva) matches.push(rva);
    for (const s of sections) {
      if (rva >= s.rva && rva - s.rva < s.size && size <= s.size - (rva - s.rva))
        matches.push(s.offset + rva - s.rva);
    }
    if (matches.length !== 1) throw new Error('Unmapped or ambiguous PE resource RVA');
    return matches[0]!;
  }
  if (directoryCount < 3) return [];
  const resourceRva = u32(optional + directory + 16),
    resourceSize = u32(optional + directory + 20);
  if (!resourceRva && !resourceSize) return [];
  if (!resourceRva || resourceSize < 16 || resourceSize > 64 * 1024 * 1024)
    throw new Error('Invalid PE resource directory size');
  const root = fileOffset(resourceRva, resourceSize),
    result: PeResource[] = [],
    visited = new Set<number>();
  let entries = 0,
    nameUnits = 0;
  const relative = (offset: number, size: number): number => {
    checkRange(resourceSize, offset, size);
    return root + offset;
  };
  function walk(offset: number, path: PeResourceId[]): void {
    if (visited.has(offset)) throw new Error('Cyclic or shared PE resource directory');
    if (visited.size >= 4096) throw new Error('PE resource directory count exceeds limit');
    visited.add(offset);
    const p = relative(offset, 16),
      named = u16(p + 12),
      count = named + u16(p + 14);
    entries += count;
    if (entries > 65536) throw new Error('PE resource entry count exceeds limit');
    relative(offset + 16, count * 8);
    const keys = new Set<PeResourceId>();
    for (let i = 0; i < count; i++) {
      const e = p + 16 + i * 8,
        name = u32(e),
        target = u32(e + 4),
        isName = !!(name & 0x80000000);
      if (isName !== i < named) throw new Error('Invalid PE named resource ordering');
      let id: PeResourceId = name;
      if (isName) {
        const start = name & 0x7fffffff,
          length = u16(relative(start, 2));
        nameUnits += length;
        if (length > 4096 || nameUnits > 1024 * 1024)
          throw new Error('PE resource name exceeds limit');
        const text = relative(start + 2, length * 2);
        id = new TextDecoder('utf-16le', {fatal: true}).decode(
          bytes.subarray(text, text + length * 2),
        );
      } else if (name > 0xffff) throw new Error('Invalid PE numeric resource ID');
      if (keys.has(id)) throw new Error('Duplicate PE resource entry');
      keys.add(id);
      if (path.length < 2) {
        if (!(target & 0x80000000)) throw new Error('Missing PE resource directory level');
        walk(target & 0x7fffffff, [...path, id]);
      } else {
        if (isName || target & 0x80000000) throw new Error('Invalid PE resource language leaf');
        const data = relative(target, 16),
          rva = u32(data),
          size = u32(data + 4);
        if (size > 64 * 1024 * 1024 || u32(data + 12))
          throw new Error('Invalid PE resource data entry');
        const start = fileOffset(rva, size);
        result.push({
          type: path[0]!,
          id: path[1]!,
          language: id as number,
          codePage: u32(data + 8),
          bytes: bytes.subarray(start, start + size),
        });
      }
    }
  }
  walk(0, []);
  return result;
}

import {checkRange} from '../../core/binary.js';
import {PeImage} from './image.js';

export type PeResourceId = number | string;
export interface PeResource {
  type: PeResourceId;
  id: PeResourceId;
  language: number;
  codePage: number;
  /** A view into the caller's executable, not a copy. */
  bytes: Uint8Array;
}

/** Read a file-layout PE32/PE32+ resource tree. Does not execute or retain the file.
 * When types are selected, unrelated payloads are not mapped. Packed images can
 * expose ordinary version resources while retaining other resources in packed sections.
 */
export function parsePeResources(bytes: Uint8Array, types?: readonly PeResourceId[]): PeResource[] {
  const image = PeImage.parse(bytes),
    v = image.view;
  const resources = image.directory(2);
  if (resources === null) return [];
  const resourceRva = resources.rva,
    resourceSize = resources.size;
  if (!resourceRva && !resourceSize) return [];
  if (!resourceRva || resourceSize < 16 || resourceSize > 64 * 1024 * 1024)
    throw new Error('Invalid PE resource directory size');
  image.fileOffset(resourceRva, 16);
  const result: PeResource[] = [],
    visited = new Set<number>();
  let entries = 0,
    nameUnits = 0;
  const relative = (offset: number, size: number): number => {
    checkRange(resourceSize, offset, size);
    return image.fileOffset(resourceRva + offset, size);
  };
  function walk(offset: number, path: PeResourceId[]): void {
    if (visited.has(offset)) throw new Error('Cyclic or shared PE resource directory');
    if (visited.size >= 4096) throw new Error('PE resource directory count exceeds limit');
    visited.add(offset);
    const p = relative(offset, 16),
      named = v.u16(p + 12),
      count = named + v.u16(p + 14);
    entries += count;
    if (entries > 65536) throw new Error('PE resource entry count exceeds limit');
    relative(offset + 16, count * 8);
    const keys = new Set<PeResourceId>();
    for (let i = 0; i < count; i++) {
      const e = p + 16 + i * 8,
        name = v.u32(e),
        target = v.u32(e + 4),
        isName = !!(name & 0x80000000);
      if (isName !== i < named) throw new Error('Invalid PE named resource ordering');
      let id: PeResourceId = name;
      if (isName) {
        const start = name & 0x7fffffff,
          length = v.u16(relative(start, 2));
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
      if (path.length === 0 && types !== undefined && !types.includes(id)) continue;
      if (path.length < 2) {
        if (!(target & 0x80000000)) throw new Error('Missing PE resource directory level');
        walk(target & 0x7fffffff, [...path, id]);
      } else {
        if (isName || target & 0x80000000) throw new Error('Invalid PE resource language leaf');
        const data = relative(target, 16),
          rva = v.u32(data),
          size = v.u32(data + 4);
        if (size > 64 * 1024 * 1024 || v.u32(data + 12))
          throw new Error('Invalid PE resource data entry');
        const start = image.fileOffset(rva, size);
        result.push({
          type: path[0]!,
          id: path[1]!,
          language: id as number,
          codePage: v.u32(data + 8),
          bytes: bytes.subarray(start, start + size),
        });
      }
    }
  }
  walk(0, []);
  return result;
}

import {byteDataView, checkRange, safeNumber} from '../core/binary.js';
import type {ByteSource} from '../core/source.js';

const MAX_IMAGE = 512 * 1024 * 1024;
const READ_CHUNK = 1024 * 1024;
const basename = (name: string): string =>
  name.replaceAll('\\', '/').split('/').at(-1)!.toLowerCase();

interface PeIdentity {
  pe: number;
  optional: number;
  table: number;
  count: number;
  magic: number;
  machine: number;
  timestamp: number;
  base: number;
  size: number;
  headers: number;
  alignment: number;
  directory: number;
}

function peIdentity(bytes: Uint8Array): PeIdentity {
  const view = byteDataView(bytes);
  checkRange(bytes.length, 0, 64);
  if (view.getUint16(0, true) !== 0x5a4d) throw new Error('Invalid PE DOS signature');
  const pe = view.getUint32(60, true);
  checkRange(bytes.length, pe, 24);
  if (pe < 64 || view.getUint32(pe, true) !== 0x4550) throw new Error('Invalid PE signature');
  const optional = pe + 24,
    optionalSize = view.getUint16(pe + 20, true);
  checkRange(bytes.length, optional, optionalSize);
  if (optionalSize < 96) throw new Error('Truncated PE optional header');
  const magic = view.getUint16(optional, true);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error('Unsupported PE optional header');
  const directory = magic === 0x10b ? 96 : 112;
  if (optionalSize < directory) throw new Error('Truncated PE data directories');
  const count = view.getUint16(pe + 6, true);
  const headers = view.getUint32(optional + 60, true);
  const size = view.getUint32(optional + 56, true);
  const base =
    magic === 0x10b
      ? view.getUint32(optional + 28, true)
      : safeNumber(view.getBigUint64(optional + 24, true));
  if (!count || count > 96 || !size || size > MAX_IMAGE || headers > size)
    throw new Error('Invalid PE image dimensions');
  if (!Number.isSafeInteger(base + size)) throw new Error('PE address exceeds exact range');
  const table = optional + optionalSize;
  checkRange(headers, table, count * 40);
  checkRange(bytes.length, 0, headers);
  const directories = view.getUint32(optional + directory - 4, true);
  if (directories > Math.floor((optionalSize - directory) / 8))
    throw new Error('Truncated PE data directories');
  const alignment = view.getUint32(optional + 32, true);
  if (!alignment || alignment & (alignment - 1)) throw new Error('Invalid PE section alignment');
  return {
    pe,
    optional,
    table,
    count,
    magic,
    machine: view.getUint16(pe + 4, true),
    timestamp: view.getUint32(pe + 8, true),
    base,
    size,
    headers,
    alignment,
    directory,
  };
}

/** Reconstruct a metadata-only file-layout PE from a supplied process snapshot.
 * Reads only directories, module names, and the matching module's memory ranges.
 * Header/section definitions come from the structurally matched original PE;
 * runtime entrypoints/imports are not repaired and this is not a runnable EXE.
 * MINIDUMP_MODULE and MEMORY64_LIST/MEMORY_LIST use the DbgHelp layouts:
 * https://learn.microsoft.com/windows/win32/api/minidumpapiset/ns-minidumpapiset-minidump_module
 * https://learn.microsoft.com/windows/win32/api/minidumpapiset/ns-minidumpapiset-minidump_memory64_list
 */
export async function recoverMinidumpPeImage(
  source: ByteSource,
  executable: Uint8Array,
  executableName: string,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  const expected = peIdentity(executable);
  if (!Number.isSafeInteger(source.size) || source.size < 0)
    throw new Error('Invalid minidump size');
  async function read(offset: number, length: number): Promise<Uint8Array> {
    checkRange(source.size, offset, length);
    const result = new Uint8Array(length);
    for (let cursor = 0; cursor < length; cursor += READ_CHUNK) {
      signal?.throwIfAborted();
      const count = Math.min(READ_CHUNK, length - cursor);
      const bytes = await source.read(offset + cursor, count, signal);
      if (bytes.length !== count) throw new Error('Truncated minidump read');
      result.set(bytes, cursor);
    }
    return result;
  }
  const header = byteDataView(await read(0, 32));
  if (header.getUint32(0, true) !== 0x504d444d || header.getUint16(4, true) !== 0xa793)
    throw new Error('Invalid minidump signature/version');
  const streamCount = header.getUint32(8, true);
  if (streamCount > 4096) throw new Error('Minidump stream count exceeds limit');
  const directory = byteDataView(await read(header.getUint32(12, true), streamCount * 12));
  const streams = new Map<number, {offset: number; size: number}>();
  for (let i = 0; i < streamCount; i++) {
    const at = i * 12,
      kind = directory.getUint32(at, true);
    const size = directory.getUint32(at + 4, true),
      offset = directory.getUint32(at + 8, true);
    checkRange(source.size, offset, size);
    if (![4, 5, 9].includes(kind)) continue;
    if (streams.has(kind)) throw new Error('Ambiguous minidump stream');
    streams.set(kind, {offset, size});
  }
  const moduleStream = streams.get(4);
  if (moduleStream === undefined) return null;
  checkRange(moduleStream.size, 0, 4);
  const moduleCount = byteDataView(await read(moduleStream.offset, 4)).getUint32(0, true);
  if (moduleCount > 8192) throw new Error('Minidump module count exceeds limit');
  checkRange(moduleStream.size, 4, moduleCount * 108);
  const modules = byteDataView(await read(moduleStream.offset + 4, moduleCount * 108));
  const nameCache = new Map<number, string>();
  let found = false;
  for (let i = 0; i < moduleCount; i++) {
    const at = i * 108,
      nameOffset = modules.getUint32(at + 20, true);
    let name = nameCache.get(nameOffset);
    if (name === undefined) {
      const length = byteDataView(await read(nameOffset, 4)).getUint32(0, true);
      if (!length || length > 65536 || length % 2) throw new Error('Invalid minidump module name');
      name = new TextDecoder('utf-16le', {fatal: true}).decode(await read(nameOffset + 4, length));
      if (name.includes('\0')) throw new Error('Invalid minidump module name');
      nameCache.set(nameOffset, name);
    }
    if (basename(name) !== basename(executableName)) continue;
    const base = safeNumber(modules.getBigUint64(at, true));
    const size = modules.getUint32(at + 8, true),
      timestamp = modules.getUint32(at + 16, true);
    if (base !== expected.base || size !== expected.size || timestamp !== expected.timestamp)
      throw new Error('Minidump module identity does not match the selected executable');
    // DbgHelp may list the same image more than once. Identical identities are
    // one mapping; a second base or conflicting identity was rejected above.
    found = true;
  }
  if (!found) return null;
  const memory64 = streams.get(9),
    memory = memory64 ?? streams.get(5);
  if (memory === undefined) throw new Error('Minidump has no captured module memory');
  const prefixSize = memory64 === undefined ? 4 : 16;
  checkRange(memory.size, 0, prefixSize);
  const prefix = byteDataView(await read(memory.offset, prefixSize));
  const rangeCount =
    memory64 === undefined ? prefix.getUint32(0, true) : safeNumber(prefix.getBigUint64(0, true));
  if (rangeCount > 1024 * 1024) throw new Error('Minidump memory range count exceeds limit');
  checkRange(memory.size, prefixSize, rangeCount * 16);
  const descriptors = byteDataView(await read(memory.offset + prefixSize, rangeCount * 16));
  const ranges: {start: number; end: number; offset: number}[] = [];
  let dataOffset = memory64 === undefined ? 0 : safeNumber(prefix.getBigUint64(8, true));
  for (let i = 0; i < rangeCount; i++) {
    const at = i * 16,
      address = safeNumber(descriptors.getBigUint64(at, true));
    const size =
      memory64 === undefined
        ? descriptors.getUint32(at + 8, true)
        : safeNumber(descriptors.getBigUint64(at + 8, true));
    if (memory64 === undefined) dataOffset = descriptors.getUint32(at + 12, true);
    checkRange(source.size, dataOffset, size);
    if (!Number.isSafeInteger(address + size))
      throw new Error('Minidump memory address exceeds exact range');
    const start = Math.max(expected.base, address),
      end = Math.min(expected.base + expected.size, address + size);
    if (start < end)
      ranges.push({
        start: start - expected.base,
        end: end - expected.base,
        offset: dataOffset + start - address,
      });
    if (memory64 !== undefined) dataOffset += size;
  }
  ranges.sort((a, b) => a.start - b.start);
  let end = 0;
  for (const range of ranges) {
    if (range.start < end) throw new Error('Ambiguous overlapping minidump module memory');
    if (range.start !== end) throw new Error('Missing minidump module memory range');
    end = range.end;
  }
  if (end !== expected.size) throw new Error('Missing minidump module memory range');
  const image = new Uint8Array(expected.size);
  for (const range of ranges)
    for (let at = range.start; at < range.end; at += READ_CHUNK) {
      const count = Math.min(READ_CHUNK, range.end - at);
      image.set(await read(range.offset + at - range.start, count), at);
    }
  const actual = peIdentity(image);
  if (
    actual.pe !== expected.pe ||
    actual.magic !== expected.magic ||
    actual.machine !== expected.machine ||
    actual.timestamp !== expected.timestamp ||
    actual.base !== expected.base ||
    actual.size !== expected.size
  )
    throw new Error('Captured PE identity does not match the selected executable');
  image.set(executable.subarray(0, expected.headers));
  const output = byteDataView(image),
    original = byteDataView(executable);
  const sections: {start: number; end: number}[] = [];
  for (let i = 0; i < expected.count; i++) {
    const at = expected.table + i * 40;
    const virtualSize = original.getUint32(at + 8, true),
      rva = original.getUint32(at + 12, true);
    const rawSize = original.getUint32(at + 16, true),
      raw = original.getUint32(at + 20, true);
    checkRange(executable.length, raw, rawSize);
    const size = Math.max(virtualSize, rawSize);
    checkRange(image.length, rva, size);
    if (size) sections.push({start: rva, end: rva + size});
    output.setUint32(at + 16, size, true);
    output.setUint32(at + 20, rva, true);
  }
  sections.sort((a, b) => a.start - b.start);
  end = expected.headers;
  for (const section of sections) {
    if (section.start < end) throw new Error('Overlapping recovered PE sections');
    end = section.end;
  }
  output.setUint32(expected.optional + 36, expected.alignment, true);
  output.setUint32(expected.optional + 64, 0, true);
  if (original.getUint32(expected.optional + expected.directory - 4, true) > 4) {
    output.setUint32(expected.optional + expected.directory + 32, 0, true);
    output.setUint32(expected.optional + expected.directory + 36, 0, true);
  }
  return image;
}

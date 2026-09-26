import type {ByteSource} from '../../core/source.js';
import {signature, view} from './binary.js';

export interface BurikoHvlEntry {
  readonly name: string;
  readonly checksum: bigint;
}
export interface BurikoHvlCatalog {
  readonly version: 1 | 2;
  readonly entries: readonly BurikoHvlEntry[];
}

/** BHV integrity catalogs contain filename/checksum pairs, not installation actions.
 * Browser inspection is bounded and stricter than the native installation loader. */
export async function readBurikoHvlCatalog(source: ByteSource): Promise<BurikoHvlCatalog> {
  if (!Number.isSafeInteger(source.size) || source.size < 16)
    throw new Error('Truncated BURIKO HVL header');
  const header = await source.read(0, 16);
  if (header.length !== 16) throw new Error('Truncated BURIKO HVL header');
  const version = signature(header, 'BHV_____') ? 1 : signature(header, 'BHV_V2__') ? 2 : null;
  if (version === null) throw new Error('Unrecognized BURIKO HVL catalog');
  const count = view(header).getUint32(12, true),
    recordSize = version === 1 ? 64 : 256,
    nameSize = recordSize - 8,
    tableSize = count * recordSize;
  if (count > 65536) throw new Error('BURIKO HVL catalog exceeds the entry limit');
  if (tableSize > source.size - 16) throw new Error('Truncated BURIKO HVL catalog');
  const table = await source.read(16, tableSize);
  if (table.length !== tableSize) throw new Error('Truncated BURIKO HVL catalog');
  const data = view(table),
    decoder = new TextDecoder('shift-jis', {fatal: true}),
    entries: BurikoHvlEntry[] = [];
  for (let index = 0; index < count; index++) {
    const offset = index * recordSize,
      field = table.subarray(offset, offset + nameSize),
      end = field.indexOf(0);
    if (end < 0) throw new Error(`BURIKO HVL entry ${index}: unterminated filename`);
    entries.push({
      name: decoder.decode(field.subarray(0, end)),
      checksum: data.getBigUint64(offset + nameSize, true),
    });
  }
  return {version, entries};
}

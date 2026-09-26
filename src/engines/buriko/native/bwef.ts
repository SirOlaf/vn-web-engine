import type {BurikoBpPointer} from '../bp/memory.js';
import {gridOutput} from './logical-grid-path.js';
import type {BurikoProgramResources, BurikoArchiveName} from './program-resources.js';

/** 140038960, the BWEF pair table: a 0x120-byte header and one DWORD per output pair. */
export function decodeBwefPairs(
  output: BurikoBpPointer | null,
  count: BurikoBpPointer | null,
  bytes: Uint8Array | null,
  size: number,
  addition: number,
): number {
  if (bytes === null)
    throw new Error('Buriko BWEF parser dereferences an unwritten resource pointer');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getBigUint64(0, true) !== 0x2020202066657762n) return 0x80000002;
  if (size >>> 0 !== view.getUint32(0x14, true) * 4 + 0x120) return 0x80000003;
  let length = view.getUint32(0x14, true);
  for (let index = 0; index < length; index++) {
    gridOutput(output, (view.getInt32(0x120 + index * 4, true) + addition) | 0, index * 8);
    gridOutput(output, view.getInt32(0x18, true), index * 8 + 4);
    length = view.getUint32(0x14, true);
  }
  gridOutput(count, length);
  return 0;
}

/** 1400388c0 performs the independent size/decode probe before the retrying load. */
export async function loadBwefPairs(
  resources: BurikoProgramResources,
  output: BurikoBpPointer | null,
  count: BurikoBpPointer | null,
  archive: BurikoArchiveName | null,
  name: Uint8Array,
  addition: number,
): Promise<number> {
  if ((await resources.size(archive, name)) === 0) return 0x80000001;
  const loaded = await resources.load(archive, name, true);
  return decodeBwefPairs(output, count, loaded.bytes, loaded.result, addition);
}

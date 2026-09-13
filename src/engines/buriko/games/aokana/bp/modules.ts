import type {AokanaBpModule, AokanaBpThread} from './state.js';

export const AOKANA_BP_MODULE_NO_SPACE = 0x80000000;
export const AOKANA_BP_MODULE_EMPTY = 0x80000001;

/** Header fields are offset/size; the two reserved words are not interpreted natively. */
export function attachModule(
  thread: AokanaBpThread,
  name: Uint8Array | string,
  decoded: Uint8Array,
): number {
  if (decoded.byteLength < 8) throw new RangeError('Truncated Aokana module header');
  const header = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  const offset = header.getUint32(0, true);
  const size = header.getUint32(4, true);
  const next = (thread.moduleSize + size) >>> 0;
  if (next > thread.moduleLimit) return AOKANA_BP_MODULE_NO_SPACE;
  if (offset + size > decoded.byteLength)
    throw new RangeError('Aokana module payload exceeds resource');
  const base = thread.moduleSize;
  if (base + size > thread.moduleMemory.byteLength)
    throw new RangeError('Aokana module copy exceeds memory');
  if (typeof name === 'string') {
    if (/[^\x00-\x7f]/.test(name))
      throw new TypeError('Aokana module names require original encoded bytes');
    name = new TextEncoder().encode(name);
  }
  const terminator = name.indexOf(0);
  thread.modules.push({
    name: name.slice(0, terminator < 0 ? name.byteLength : terminator),
    base,
    size,
  });
  thread.moduleMemory.set(decoded.subarray(offset, offset + size), base);
  thread.moduleSize = next;
  return base;
}

export function detachLastModule(thread: AokanaBpThread): number {
  const module = thread.modules.pop();
  if (!module) return AOKANA_BP_MODULE_EMPTY;
  thread.moduleSize = (thread.moduleSize - module.size) >>> 0;
  return thread.modules.length >>> 0;
}

/** CThread virtual +38 (140088370): borrowed regions precede this thread's newest-first list.
 * DCTChildThread forwards only the nonzero include-borrowers call to its original owner. */
export function listThreadModules(
  thread: AokanaBpThread,
  includeBorrowers: boolean,
): AokanaBpModule[] {
  if (includeBorrowers) thread = thread.storageOwner;
  const result: AokanaBpModule[] = [];
  if (includeBorrowers) {
    for (let index = 0; index < thread.retentionCount; index++) {
      const reservation = thread.moduleReservations[index];
      if (reservation === undefined)
        throw new Error('Aokana module diagnostic dereferences a missing borrowed-region record');
      for (const module of listThreadModules(reservation.borrower, false)) result.push(module);
    }
  }
  for (let index = thread.modules.length - 1; index >= 0; index--) {
    const module = thread.modules[index]!;
    // Native output records copy pointer/size/base, retaining the source name allocation.
    result.push({name: module.name, size: module.size, base: module.base});
  }
  return result;
}

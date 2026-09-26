import {pointerView, type BurikoBpMemory, type BurikoBpPointer} from '../bp/memory.js';
import type {BurikoBpThread} from '../bp/state.js';

/** EE6E0 resolves each DWORD VM address in ascending order into a native pointer array. */
export function resolveBurikoAddressArray(
  memory: BurikoBpMemory,
  thread: BurikoBpThread,
  addresses: BurikoBpPointer | null,
  count: number,
): (BurikoBpPointer | null)[] {
  count |= 0;
  if (count <= 0) return [];
  const input = pointerView(addresses!, count * 4);
  return Array.from({length: count}, (_, index) =>
    memory.resolve(thread, input.getUint32(index * 4, true)),
  );
}

import {pointerView, type AokanaBpMemory, type AokanaBpPointer} from '../bp/memory.js';
import type {AokanaBpThread} from '../bp/state.js';

/** EE6E0 resolves each DWORD VM address in ascending order into a native pointer array. */
export function resolveAokanaAddressArray(
  memory: AokanaBpMemory,
  thread: AokanaBpThread,
  addresses: AokanaBpPointer | null,
  count: number,
): (AokanaBpPointer | null)[] {
  count |= 0;
  if (count <= 0) return [];
  const input = pointerView(addresses!, count * 4);
  return Array.from({length: count}, (_, index) =>
    memory.resolve(thread, input.getUint32(index * 4, true)),
  );
}

import type {AokanaBpPointer} from '../bp/memory.js';
import {pop32, push32} from '../bp/state.js';
import {pointerBytes} from '../bp/opcodes/operands.js';
import {AokanaDiagnosticCounts, AokanaPooledAllocationDiagnostics} from './diagnostic-records.js';
import {AokanaProgramFiles} from './program-files.js';
import {AokanaSpecialFolders} from './special-folders.js';
import {textBytes, textLength, writeText} from './text.js';
import type {AokanaNativeSlotDefinition} from './types.js';

/** Native E0 writers create even an empty file, ignore each WriteFile result, and preserve list order. */
export function createGroupE0Files(
  files: AokanaProgramFiles,
  folders: AokanaSpecialFolders,
  counts: AokanaDiagnosticCounts,
  allocations: AokanaPooledAllocationDiagnostics,
): AokanaNativeSlotDefinition[] {
  const write = async (
    name: AokanaBpPointer | null,
    selector: number,
    pooled: boolean,
  ): Promise<number> => {
    if (selector !== 0 && selector !== 1) return 1;
    const bytes = new Uint8Array(784),
      root = {bytes, offset: 0};
    const initialized =
      selector === 0 ? folders.resourceRoot(root, 0) : await folders.query(root, 1);
    if (initialized === 0)
      throw new Error('Aokana diagnostic writer reads unwritten native folder scratch');
    const size = textLength(root);
    if (size > 0 && bytes[size - 1] !== 92) writeText({bytes, offset: size}, Uint8Array.of(92, 0));
    if (name === null) throw new Error('Aokana diagnostic writer dereferences a null filename');
    folders.combine(root, root, 0, name);
    const output = await files.createOutput(textBytes(root));
    if (output === null) return 2;
    try {
      if (pooled) {
        for (const record of allocations.records) {
          const at = record.text.indexOf(0);
          await output.write(at < 0 ? record.text : record.text.subarray(0, at));
        }
      } else
        for (const bank of counts.banks) {
          for (let index = 0; index < bank.count; index++) {
            const countBytes = pointerBytes(bank.counts, 4, index * 4);
            const count = new DataView(countBytes.buffer, countBytes.byteOffset, 4).getInt32(
              0,
              true,
            );
            if (count === 0) continue;
            if (bank.flags === null)
              throw new Error('Aokana diagnostic writer dereferences null flags');
          if ((pointerBytes(bank.flags, 1, index * 4)[0]! & 1) !== 0) continue;
            const hex = (value: number): string =>
              (value >>> 0).toString(16).toUpperCase().padStart(2, '0');
            await output.write(
              new TextEncoder().encode(`0x${hex(bank.bank)}${hex(index)} : ${count}\n`),
            );
          }
        }
    } finally {
      output.close();
    }
    return 0;
  };
  return [
    {
      primary: 0xe0,
      secondary: 0x92,
      nativeAddress: 0x1400aae10,
      name: 'WriteDiagnosticCounts',
      execute: async (h): Promise<0> => {
        const selector = pop32(h.thread),
          name = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, await write(name, selector, false));
        return 0;
      },
    },
    {
      primary: 0xe0,
      secondary: 0xc2,
      nativeAddress: 0x1400aaa40,
      name: 'WritePooledAllocationDiagnostics',
      execute: async (h): Promise<0> => {
        const selector = pop32(h.thread),
          name = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, await write(name, selector, true));
        return 0;
      },
    },
  ];
}

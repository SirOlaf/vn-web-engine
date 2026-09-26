import {pop32, push32} from '../bp/state.js';
import type {AokanaFileEnumeration} from './file-enumeration.js';
import type {AokanaNativeSlotDefinition} from './types.js';
export function createGroup80Enumeration(
  files: AokanaFileEnumeration,
): AokanaNativeSlotDefinition[] {
  const enumerate =
    (directories: boolean): AokanaNativeSlotDefinition['execute'] =>
    async (h): Promise<0> => {
      const maximum = pop32(h.thread),
        recursive = !directories && pop32(h.thread) !== 0;
      const pattern = h.memory.resolve(h.thread, pop32(h.thread)),
        capacity = pop32(h.thread),
        output = h.memory.resolve(h.thread, pop32(h.thread));
      const result = await files.enumerate(
        output,
        capacity,
        pattern!,
        recursive,
        maximum,
        directories,
      );
      push32(h.thread, output === null ? result.size : result.count);
      return 0;
    };
  return [
    {
      primary: 0x80,
      secondary: 0x24,
      nativeAddress: 0x1400e9aa0,
      name: 'CountFiles',
      execute: async (h): Promise<0> => {
        const recursive = pop32(h.thread) !== 0,
          pattern = h.memory.resolve(h.thread, pop32(h.thread));
        const result = await files.enumerate(null, 0, pattern!, recursive, 0x7fffffff);
        push32(h.thread, result.count);
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x25,
      nativeAddress: 0x1400e99f0,
      name: 'EnumerateFiles',
      execute: enumerate(false),
    },
    {
      primary: 0x80,
      secondary: 0x26,
      nativeAddress: 0x1400e9970,
      name: 'EnumerateDirectories',
      execute: enumerate(true),
    },
  ];
}

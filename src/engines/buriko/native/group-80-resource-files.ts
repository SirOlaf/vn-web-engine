import {pop32, push32} from '../bp/state.js';
import {textBytes} from './text.js';
import type {BurikoResourceFileServices} from './resource-file-services.js';
import type {BurikoNativeSlotDefinition} from './types.js';
export function createGroup80ResourceFiles(
  files: BurikoResourceFileServices,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0x32,
      nativeAddress: 0x1400e9420,
      name: 'WriteResourceFile',
      execute: async (h): Promise<0> => {
        const length = pop32(h.thread),
          data = h.memory.resolve(h.thread, pop32(h.thread)),
          name = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, Number((await files.write(name, data, length)) === length >>> 0));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x33,
      nativeAddress: 0x1400e93a0,
      name: 'DeleteResourceFile',
      execute: async (h): Promise<0> => {
        const name = h.memory.resolve(h.thread, pop32(h.thread)),
          explicit = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, await files.remove(explicit, name));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x34,
      nativeAddress: 0x1400e9350,
      name: 'IsResourceAvailable',
      execute: async (h): Promise<0> => {
        const name = h.memory.resolve(h.thread, pop32(h.thread)),
          archive = h.memory.resolve(h.thread, pop32(h.thread));
        push32(
          h.thread,
          await files.available(archive === null ? null : () => textBytes(archive), name),
        );
        return 0;
      },
    },
  ];
}

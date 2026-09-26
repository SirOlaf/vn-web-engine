import {pop32, push32} from '../bp/state.js';
import type {BurikoNamedMutexes} from './named-mutexes.js';
import type {BurikoNativeSlotDefinition} from './types.js';

export function createGroup81NamedMutexes(
  mutexes: BurikoNamedMutexes,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0xec,
      nativeAddress: 0x1400ea7f0,
      name: 'CreateNamedMutex',
      execute: (h) => {
        const name = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, mutexes.create(name));
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0xed,
      nativeAddress: 0x1400ea7c0,
      name: 'ReleaseNamedMutex',
      execute: (h) => {
        push32(h.thread, mutexes.release(pop32(h.thread)));
        return 0;
      },
    },
  ];
}

import {pop32, push32} from '../bp/state.js';
import {textBytes} from './text.js';
import type {BurikoTemporaryDirectoryProbe} from './temporary-directory-probe.js';
import type {BurikoNativeSlotDefinition} from './types.js';

export function createGroup81TemporaryDirectory(
  probe: BurikoTemporaryDirectoryProbe,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0x2f,
      nativeAddress: 0x1400ebde0,
      name: 'ProbeTemporaryDirectory',
      execute: async (h): Promise<0> => {
        const path = h.memory.resolve(h.thread, pop32(h.thread));
        const ownedPath = textBytes(path!, true).slice();
        push32(h.thread, await probe.probe(ownedPath));
        return 0;
      },
    },
  ];
}

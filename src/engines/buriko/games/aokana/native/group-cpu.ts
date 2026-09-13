import {pointerView} from '../bp/memory.js';
import {pop32, push32} from '../bp/state.js';
import type {AokanaCpuProfile} from './cpu-profile.js';
import type {AokanaNativeSlotDefinition} from './types.js';
import {writeText} from './text.js';

/** Both CPU services read the same explicit native CPU owner as renderer startup. */
export function createGroupCpu(cpu: AokanaCpuProfile): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0x0a,
      nativeAddress: 0x1400ea140,
      name: 'ReadCpuRecord',
      execute: (h) => {
        const destination = h.memory.resolve(h.thread, pop32(h.thread));
        if (destination === null) throw new Error('Aokana CPU record null destination');
        cpu.copyRecord(pointerView(destination, 64));
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0x0a,
      nativeAddress: 0x1400ec6b0,
      name: 'ReadCpuBrand',
      execute: (h) => {
        const destination = h.memory.resolve(h.thread, pop32(h.thread));
        const brand = cpu.brand();
        if (brand !== null) {
          if (destination === null) throw new Error('Aokana CPU brand null destination');
          writeText(destination, Uint8Array.of(...brand, 0));
        }
        push32(h.thread, Number(brand !== null));
        return 0;
      },
    },
  ];
}

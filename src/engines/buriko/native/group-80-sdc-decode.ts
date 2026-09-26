import {pop32, push32} from '../bp/state.js';
import {decodeBurikoSdcInto} from './sdc.js';
import type {BurikoNativeSlotDefinition} from './types.js';

export function createGroup80SdcDecode(): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0xc1,
      nativeAddress: 0x1400e7260,
      name: 'DecompressSdcIntoCaller',
      execute: (h) => {
        const source = h.memory.resolve(h.thread, pop32(h.thread)),
          destination = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, decodeBurikoSdcInto(destination, source));
        return 0;
      },
    },
  ];
}

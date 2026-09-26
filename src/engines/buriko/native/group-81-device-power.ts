import {pop32, push32} from '../bp/state.js';
import type {BurikoDevicePower} from './device-power.js';
import type {BurikoNativeSlotDefinition} from './types.js';

export function createGroup81DevicePower(power: BurikoDevicePower): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0x3e,
      nativeAddress: 0x1400eb6b0,
      name: 'ReadDevicePowerState',
      execute: (h) => {
        const path = h.memory.resolve(h.thread, pop32(h.thread));
        const output = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, power.read(output, path!));
        return 0;
      },
    },
  ];
}

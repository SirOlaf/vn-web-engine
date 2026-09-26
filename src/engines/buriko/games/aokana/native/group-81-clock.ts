import {pop32, push32} from '../bp/state.js';
import type {AokanaNativeClock} from './clock.js';
import type {AokanaNativeSlotDefinition} from './types.js';

export function createGroup81Clock(clock: AokanaNativeClock): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0x04,
      nativeAddress: 0x1400ec7f0,
      name: 'SetClockGapLimit',
      execute: (h) => {
        push32(h.thread, Number(clock.setGapLimit(pop32(h.thread))));
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0x68,
      nativeAddress: 0x1400eb2c0,
      name: 'ExchangeClockPauseOption',
      execute: (h) => {
        push32(h.thread, clock.setPauseOption(pop32(h.thread)));
        return 0;
      },
    },
  ];
}

/** rand_s uses one uniform cryptographic DWORD, preserving its native modulo bias. */
export function createGroup81Random(
  crypto: Pick<Crypto, 'getRandomValues'>,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0x06,
      nativeAddress: 0x1400ec790,
      name: 'RandomInteger',
      execute: (h) => {
        const bound = pop32(h.thread) | 0;
        let result = 0;
        if (bound !== 0) {
          const random = crypto.getRandomValues(new Uint32Array(1))[0]!;
          result = bound > 0 ? random % bound : -(random % -bound);
        }
        push32(h.thread, result);
        return 0;
      },
    },
  ];
}

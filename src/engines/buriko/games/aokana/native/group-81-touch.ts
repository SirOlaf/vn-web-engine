import {pop32, push32} from '../bp/state.js';
import type {AokanaNativeTouch} from './touch-input.js';
import type {AokanaNativeSlotDefinition} from './types.js';

export function createGroup81Touch(touch: AokanaNativeTouch): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0x16,
      nativeAddress: 0x1400ec440,
      name: 'ConfigureTouchHistory',
      execute: (h) => {
        const distance = pop32(h.thread),
          limit = pop32(h.thread);
        push32(h.thread, touch.configureHistory(limit, distance));
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0x17,
      nativeAddress: 0x1400ec3c0,
      name: 'ReadTouchHistory',
      execute: (h) => {
        const count = pop32(h.thread),
          index = pop32(h.thread),
          angles = h.memory.resolve(h.thread, pop32(h.thread)),
          positions = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, touch.copyHistory(positions, angles, index, count));
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0x18,
      nativeAddress: 0x1400ec390,
      name: 'SetTouchRegistration',
      execute: (h) => {
        push32(h.thread, touch.setRegistration(pop32(h.thread)));
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0x19,
      nativeAddress: 0x1400ec360,
      name: 'ReadTouchContacts',
      execute: (h) => {
        push32(h.thread, touch.copyContacts(h.memory.resolve(h.thread, pop32(h.thread))));
        return 0;
      },
    },
  ];
}

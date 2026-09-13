import {pop32, push32} from '../bp/state.js';
import type {AokanaNativeSplines} from './spline-registry.js';
import type {AokanaNativeSlotDefinition} from './types.js';

/** C0C0..C3 use the same verified CSpline as grid visibility, with separate registry lifetimes. */
export function createGroupC0Splines(splines: AokanaNativeSplines): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0xc0,
      secondary: 0xc0,
      nativeAddress: 0x1400d0460,
      name: 'CreateNativeSpline',
      execute: (h) => {
        push32(h.thread, splines.create());
        return 0;
      },
    },
    {
      primary: 0xc0,
      secondary: 0xc1,
      nativeAddress: 0x1400d0430,
      name: 'DeleteNativeSpline',
      execute: (h) => {
        push32(h.thread, splines.remove(pop32(h.thread)));
        return 0;
      },
    },
    {
      primary: 0xc0,
      secondary: 0xc2,
      nativeAddress: 0x1400d03d0,
      name: 'InitializeNativeSpline',
      execute: (h) => {
        const duration = pop32(h.thread),
          points = h.memory.resolve(h.thread, pop32(h.thread)),
          count = pop32(h.thread),
          id = pop32(h.thread);
        push32(h.thread, splines.initialize(id, count, points, duration));
        return 0;
      },
    },
    {
      primary: 0xc0,
      secondary: 0xc3,
      nativeAddress: 0x1400d0370,
      name: 'SampleNativeSpline',
      execute: (h) => {
        const time = pop32(h.thread),
          id = pop32(h.thread),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, splines.sample(output, id, time));
        return 0;
      },
    },
  ];
}

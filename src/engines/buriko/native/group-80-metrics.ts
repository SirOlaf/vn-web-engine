import {pointerView} from '../bp/memory.js';
import {pop32} from '../bp/state.js';
import type {BurikoFrameMetrics} from './frame-metrics.js';
import type {BurikoNativeSlotDefinition} from './types.js';

/** 80 06/07 share the actual simulation/draw measurement owner at 1d0390. */
export function createGroup80Metrics(metrics: BurikoFrameMetrics): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0x06,
      nativeAddress: 0x1400ea220,
      name: 'EnableFrameMetrics',
      execute: (h) => {
        metrics.enable(pop32(h.thread));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x07,
      nativeAddress: 0x1400ea1f0,
      name: 'ReadFrameMetric',
      execute: (h) => {
        const selector = pop32(h.thread),
          destination = h.memory.resolve(h.thread, pop32(h.thread));
        const value = metrics.read(selector);
        if (destination === null) throw new Error('Buriko frame metric null destination');
        pointerView(destination, 4).setUint32(0, value, true);
        return 0;
      },
    },
  ];
}

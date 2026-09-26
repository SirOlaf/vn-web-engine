import {pop32, push32} from '../bp/state.js';
import type {BurikoNativeSlotDefinition} from './types.js';
import type {BurikoVolumeLabels} from './volume-labels.js';

export function createGroup81VolumeLabels(
  labels: BurikoVolumeLabels,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0x3d,
      nativeAddress: 0x1400eb700,
      name: 'ReadVolumeLabel',
      execute: (h) => {
        const drive = h.memory.resolve(h.thread, pop32(h.thread));
        const output = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, labels.read(output, drive!));
        return 0;
      },
    },
  ];
}

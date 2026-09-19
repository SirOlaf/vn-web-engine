import {pop32, push32} from '../bp/state.js';
import type {AokanaNativeSlotDefinition} from './types.js';
import type {AokanaVolumeLabels} from './volume-labels.js';

export function createGroup81VolumeLabels(
  labels: AokanaVolumeLabels,
): AokanaNativeSlotDefinition[] {
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

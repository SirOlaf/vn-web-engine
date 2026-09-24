import {pop32, push32} from '../bp/state.js';
import {loadAokanaImmediateBmp} from './immediate-bmp.js';
import type {AokanaProgramResources} from './program-resources.js';
import type {AokanaSurfaces} from './surfaces.js';
import type {AokanaNativeSlotDefinition} from './types.js';

export function createGroup92ImmediateBmp(
  surfaces: AokanaSurfaces,
  resources: AokanaProgramResources,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x92,
      secondary: 0x1f,
      nativeAddress: 0x1400e3fa0,
      name: 'LoadImmediateWindowsBitmap',
      execute: async ({thread, memory}): Promise<0> => {
        const name = memory.resolve(thread, pop32(thread)),
          surface = pop32(thread);
        push32(thread, await loadAokanaImmediateBmp(surfaces, resources, surface, name));
        return 0;
      },
    },
  ];
}

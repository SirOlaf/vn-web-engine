import {pop32} from '../bp/state.js';
import {projectBurikoPoint} from './perspective-point.js';
import type {BurikoNativeSlotDefinition} from './types.js';

export function createGroup90PerspectivePoint(): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x90,
      secondary: 0xcf,
      nativeAddress: 0x1400d6dd0,
      name: 'ProjectPerspectivePoint',
      execute: ({thread, memory}) => {
        const perspectiveY = pop32(thread),
          perspectiveX = pop32(thread),
          source = memory.resolve(thread, pop32(thread)),
          destination = memory.resolve(thread, pop32(thread));
        projectBurikoPoint(destination, source, perspectiveX, perspectiveY);
        return 0;
      },
    },
  ];
}

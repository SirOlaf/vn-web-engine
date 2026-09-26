import {pop32, push32} from '../bp/state.js';
import type {BurikoSurfaces} from './surfaces.js';
import type {BurikoNativeSlotDefinition} from './types.js';

export function createGroup92SurfacePixels(surfaces: BurikoSurfaces): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x92,
      secondary: 0x12,
      nativeAddress: 0x1400e4a40,
      name: 'SetSurfaceMetadata',
      execute: ({thread}) => {
        const y = pop32(thread),
          x = pop32(thread),
          surface = pop32(thread);
        push32(thread, surfaces.setMetadata(surface, x, y));
        return 0;
      },
    },
    {
      primary: 0x92,
      secondary: 0x13,
      nativeAddress: 0x1400e49f0,
      name: 'ReplaceSurfaceColor',
      execute: ({thread}) => {
        const replacement = pop32(thread),
          search = pop32(thread),
          surface = pop32(thread);
        push32(thread, surfaces.replaceColor(surface, search, replacement));
        return 0;
      },
    },
    {
      primary: 0x92,
      secondary: 0x16,
      nativeAddress: 0x1400e4900,
      name: 'GetSurfaceMetadata',
      execute: ({thread, memory}) => {
        const surface = pop32(thread),
          output = memory.resolve(thread, pop32(thread));
        push32(thread, surfaces.getMetadata(output, surface));
        return 0;
      },
    },
    {
      primary: 0x92,
      secondary: 0x17,
      nativeAddress: 0x1400e4880,
      name: 'ReadSurfacePixel',
      execute: ({thread, memory}) => {
        const y = pop32(thread),
          x = pop32(thread),
          surface = pop32(thread),
          output = memory.resolve(thread, pop32(thread));
        push32(thread, surfaces.readPixel(output, surface, x, y));
        return 0;
      },
    },
  ];
}

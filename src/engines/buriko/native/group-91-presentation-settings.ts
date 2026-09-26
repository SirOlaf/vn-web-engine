import {pop32, push32} from '../bp/state.js';
import type {BurikoNativeDisplayState} from './display-state.js';
import type {BurikoMovieImageConfiguration} from './movie-image.js';
import type {BurikoNativeSlotDefinition} from './types.js';

/** The shared display state is consumed by BurikoDisplayFrames. */
export function createGroup91ContinuousPresentation(
  display: BurikoNativeDisplayState,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x91,
      secondary: 0x00,
      nativeAddress: 0x1400e2c80,
      name: 'SetContinuousPresentation',
      execute: (h) => {
        display.continuousPresentation = pop32(h.thread);
        return 0;
      },
    },
  ];
}

/** Both arguments are the shared instances consumed by frame and movie renderers. */
export function createGroup91PresentationSettings(
  display: BurikoNativeDisplayState,
  movies: BurikoMovieImageConfiguration,
): BurikoNativeSlotDefinition[] {
  return [
    ...createGroup91ContinuousPresentation(display),
    {
      primary: 0x91,
      secondary: 0x09,
      nativeAddress: 0x1400e2a60,
      name: 'SetMovieDimensionMode',
      execute: (h) => {
        const mode = pop32(h.thread) >>> 0;
        if (mode < 2) {
          movies.dimensionMode = mode;
          push32(h.thread, 1);
        } else push32(h.thread, 0);
        return 0;
      },
    },
  ];
}

import {pointerView} from '../bp/memory.js';
import {pop32, push32} from '../bp/state.js';
import type {BurikoBrowserSurfaceMovieFactory} from './movie-browser-surface.js';
import type {BurikoMovieFramePosition} from './movie-frame-position.js';
import type {BurikoMovieRegistry} from './movie-registry.js';
import type {BurikoSurfaces} from './surfaces.js';
import type {BurikoBpOpcodeContext, BurikoNativeSlotDefinition} from './types.js';

/** Surface movie callbacks over one selected physical source/renderer/registry owner. */
export function createGroup91SurfaceMovies(
  factory: BurikoBrowserSurfaceMovieFactory,
  surfaces: BurikoSurfaces,
  movies: BurikoMovieRegistry,
  framePosition: BurikoMovieFramePosition,
): BurikoNativeSlotDefinition[] {
  if (
    factory.graph.surfaces !== surfaces ||
    factory.graph.movies !== movies ||
    framePosition.surfaces !== surfaces ||
    framePosition.movies !== movies
  )
    throw new Error('Buriko surface movie callbacks require one graph and registry');
  const pointer = (h: BurikoBpOpcodeContext) => h.memory.resolve(h.thread, pop32(h.thread));
  const mapped = (status: number): number =>
    status === 0
      ? 0
      : status === 0x80000001
        ? 1
        : status === 0x80000002
          ? 2
          : status === 0x80000003
            ? 3
            : status === 0x80000004
              ? 4
              : status;
  const rendererFor = (slot: number) => {
    const record = surfaces.record(slot);
    if (record === null || record.movieId === -1) return null;
    if (surfaces.descriptor(slot) === null) return null;
    return movies.find(record.movieId);
  };
  return [
    {
      primary: 0x91,
      secondary: 0xf0,
      nativeAddress: 0x1400de410,
      name: 'CreateSurfaceMovie',
      execute: async (h): Promise<0> => {
        const volume = pop32(h.thread),
          repeat = pop32(h.thread),
          name = pointer(h),
          slot = pop32(h.thread);
        if (name === null) throw new Error('Buriko surface movie consumes a null filename');
        push32(h.thread, mapped(await factory.create(slot, name, repeat, volume)));
        return 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0xf1,
      nativeAddress: 0x1400de3a0,
      name: 'StartSurfaceMovie',
      execute: async (h): Promise<0> => {
        const slot = pop32(h.thread),
          output = pointer(h);
        const renderer = rendererFor(slot);
        if (renderer === null) {
          const record = surfaces.record(slot);
          const status = record === null || record.movieId === -1 ? 4 : 1;
          if (status === 1) movies.detachSlot(surfaces, slot);
          push32(h.thread, status);
          return 0;
        }
        const result = await renderer.start(output !== null);
        if (result.status === 0) {
          if (output !== null && result.remainingMilliseconds !== undefined)
            pointerView(output, 4).setInt32(0, result.remainingMilliseconds, true);
          push32(h.thread, 0);
        } else {
          movies.detachSlot(surfaces, slot);
          push32(h.thread, 1);
        }
        return 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0xf2,
      nativeAddress: 0x1400de330,
      name: 'DetachSurfaceMovie',
      execute: (h) => {
        push32(h.thread, mapped(movies.detachSlot(surfaces, pop32(h.thread))));
        return 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0xf3,
      nativeAddress: 0x1400de2b0,
      name: 'PauseSurfaceMovie',
      execute: async (h): Promise<0> => {
        const pause = pop32(h.thread),
          slot = pop32(h.thread);
        const record = surfaces.record(slot);
        if (record === null || record.movieId === -1) {
          push32(h.thread, 4);
          return 0;
        }
        const renderer = rendererFor(slot);
        push32(h.thread, renderer !== null && (await renderer.pause(pause)) === 0 ? 0 : 1);
        return 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0xf7,
      nativeAddress: 0x1400de260,
      name: 'GetSurfaceMovieFrame',
      execute: (h) => {
        const slot = pop32(h.thread),
          output = pointer(h);
        const result = framePosition.read(slot);
        if (result.found) pointerView(output!, 4).setInt32(0, result.frame, true);
        push32(h.thread, Number(result.found));
        return 0;
      },
    },
  ];
}

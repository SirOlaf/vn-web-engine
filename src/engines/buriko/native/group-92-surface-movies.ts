import {pointerView} from '../bp/memory.js';
import {pop32, push32} from '../bp/state.js';
import type {BurikoBrowserSurfaceMovieFactory} from './movie-browser-surface.js';
import type {BurikoMovieRegistry} from './movie-registry.js';
import type {BurikoSurfaces} from './surfaces.js';
import type {BurikoBpOpcodeContext, BurikoNativeSlotDefinition} from './types.js';

/** Archive create and live timeline controls over the same 91 surface movie owner. */
export function createGroup92SurfaceMovies(
  factory: BurikoBrowserSurfaceMovieFactory,
  surfaces: BurikoSurfaces,
  movies: BurikoMovieRegistry,
): BurikoNativeSlotDefinition[] {
  if (factory.graph.surfaces !== surfaces || factory.graph.movies !== movies)
    throw new Error('Buriko 92 movie callbacks require the mounted surface movie owner');
  const pointer = (h: BurikoBpOpcodeContext) => h.memory.resolve(h.thread, pop32(h.thread));
  const rendererFor = (slot: number) => {
    const record = surfaces.record(slot);
    if (record === null || record.movieId === -1) return {status: 4, renderer: null};
    if (surfaces.descriptor(slot) === null) return {status: 1, renderer: null};
    const renderer = movies.find(record.movieId);
    return renderer === null ? {status: 1, renderer: null} : {status: 0, renderer};
  };
  const mappedCreate = (status: number): number =>
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
  return [
    {
      primary: 0x92,
      secondary: 0xf2,
      nativeAddress: 0x1400e2ea0,
      name: 'CreateArchivedSurfaceMovie',
      execute: async (h): Promise<0> => {
        const volume = pop32(h.thread),
          repeat = pop32(h.thread),
          name = pointer(h),
          archive = pointer(h),
          slot = pop32(h.thread);
        if (name === null) throw new Error('Buriko surface movie consumes a null filename');
        push32(h.thread, mappedCreate(await factory.create(slot, name, repeat, volume, archive)));
        return 0;
      },
    },
    {
      primary: 0x92,
      secondary: 0xf4,
      nativeAddress: 0x1400e2e00,
      name: 'SeekSurfaceMovieMilliseconds',
      execute: (h) => {
        const milliseconds = pop32(h.thread),
          slot = pop32(h.thread),
          found = rendererFor(slot);
        push32(
          h.thread,
          found.renderer === null ? found.status : found.renderer.seek(milliseconds) === 0 ? 0 : 5,
        );
        return 0;
      },
    },
    {
      primary: 0x92,
      secondary: 0xf5,
      nativeAddress: 0x1400e2d90,
      name: 'GetSurfaceMovieMilliseconds',
      execute: (h) => {
        const slot = pop32(h.thread),
          output = pointer(h),
          found = rendererFor(slot);
        if (found.renderer === null) push32(h.thread, found.status);
        else {
          const result = found.renderer.milliseconds();
          if (result.status === 0) {
            pointerView(output!, 4).setInt32(0, result.value!, true);
            push32(h.thread, 0);
          } else push32(h.thread, 4);
        }
        return 0;
      },
    },
    {
      primary: 0x92,
      secondary: 0xf6,
      nativeAddress: 0x1400e2cf0,
      name: 'SetSurfaceMovieVolume',
      execute: (h) => {
        const volume = pop32(h.thread),
          slot = pop32(h.thread),
          found = rendererFor(slot);
        if (found.renderer === null) push32(h.thread, found.status);
        else {
          const result = found.renderer.volume(volume);
          push32(h.thread, result === 0 ? 0 : result === 0x80000003 ? 3 : 1);
        }
        return 0;
      },
    },
  ];
}

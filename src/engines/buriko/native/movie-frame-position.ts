import type {BurikoMovieRegistry} from './movie-registry.js';
import type {BurikoSurfaces} from './surfaces.js';

export type BurikoMovieFramePositionResult =
  {readonly found: false} | {readonly found: true; readonly frame: number};

/** 040530's frame query over the actual surface table and movie registry.
 * A later 91:F7 wrapper owns the BP output write and Boolean push. */
export class BurikoMovieFramePosition {
  constructor(
    readonly surfaces: BurikoSurfaces,
    readonly movies: BurikoMovieRegistry,
  ) {
    if (!surfaces.usesMovieRegistry(movies))
      throw new Error('Buriko frame query requires the attached surface movie registry');
  }

  read(slot: number): BurikoMovieFramePositionResult {
    const index = slot | 0;
    const record = this.surfaces.record(index);
    if (record === null || this.surfaces.descriptor(index) === null) return {found: false};
    if (record.movieId === -1) return {found: true, frame: record.frame | 0};
    const renderer = this.movies.find(record.movieId);
    if (renderer === null) return {found: false};
    if (renderer.surfaces !== this.surfaces || renderer.slot !== index)
      throw new Error('Buriko frame query requires the surface movie registry identity');
    // 0951D0 reads the raw started field, not the time-dependent isPlaying result.
    if (renderer.started === 0) return {found: true, frame: -1};
    const position = renderer.framePosition();
    return position.status === 0 ? {found: true, frame: position.value! | 0} : {found: false};
  }
}

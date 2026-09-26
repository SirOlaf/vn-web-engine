import {aokanaIsoReferenceTime} from './movie-iso-timeline.js';
import type {AokanaBrowserMoviePcmOutput, AokanaMemoryMoviePcmOutput} from './movie-pcm-output.js';
import type {AokanaMovieGraphClock} from './movie-render-events.js';

/**
 * Absolute movie time from actual PCM output acknowledgment. Connect to absolute
 * movie sample times with graphStart=0; do not subtract the seek position again.
 * Render-duration measurements retain the separate real monotonic raw clock.
 */
export class AokanaMoviePcmGraphClock implements AokanaMovieGraphClock {
  constructor(private readonly output: AokanaMemoryMoviePcmOutput | AokanaBrowserMoviePcmOutput) {}

  now(): bigint {
    const status = this.output.acknowledgedStatus;
    if (status === null) throw new Error('Movie PCM graph clock has no output acknowledgment');
    return aokanaIsoReferenceTime(status.position);
  }
}

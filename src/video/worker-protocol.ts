import type {WorkerSource} from '../core/worker-source.js';
import type {MovieInfo, MoviePcm, MovieFrame} from './movie-types.js';
export type MovieRequest = {type: 'open'; source: WorkerSource; seek: number} | {type: 'pull'};
export type MovieResponse =
  | {
      type: 'batch';
      frames: MovieFrame[];
      audio: MoviePcm[];
      info: MovieInfo;
      done: boolean;
      decodeMs: number;
    }
  | {type: 'seeking'; progress: number}
  | {type: 'error'; message: string};

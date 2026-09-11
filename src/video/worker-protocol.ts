import type {WorkerSource} from '../core/worker-source.js';
import type {MovieInfo, MoviePcm} from '../formats/cri/movie.js';
import type {YuvFrame} from './frame.js';
export type MovieRequest = {type: 'open'; source: WorkerSource; seek: number} | {type: 'pull'};
export type MovieResponse =
  | {
      type: 'batch';
      frames: YuvFrame[];
      audio: MoviePcm[];
      info: MovieInfo;
      done: boolean;
      decodeMs: number;
    }
  | {type: 'seeking'; progress: number}
  | {type: 'error'; message: string};

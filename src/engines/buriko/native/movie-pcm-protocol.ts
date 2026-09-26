import type {BurikoIsoRational} from './movie-iso-timeline.js';
import type {BurikoMovieAudioSpan} from './movie-audio-samples.js';
export interface BurikoMoviePcmFormat {
  readonly channels: 1 | 2;
  readonly capacityFrames: number;
}
export type BurikoMoviePcmCommand =
  | {kind: 'enqueue'; generation: number; span: BurikoMovieAudioSpan}
  | {kind: 'commit'; generation: number; through: BurikoIsoRational}
  | {kind: 'run' | 'pause' | 'dispose'; generation: number}
  | {kind: 'gain'; generation: number; decibels: number}
  | {kind: 'flush'; generation: number; position: BurikoIsoRational}
  | {kind: 'end'; generation: number; position: BurikoIsoRational}
  | {kind: 'status'};
export interface BurikoMoviePcmStatus {
  readonly result: 'ok' | 'would-block' | 'stale';
  readonly generation: number;
  readonly position: BurikoIsoRational;
  readonly committedThrough: BurikoIsoRational;
  readonly stop: BurikoIsoRational | null;
  readonly consumedFrames: bigint;
  readonly retainedFrames: number;
  readonly availableFrames: number;
  readonly running: boolean;
  readonly ended: boolean;
}
export interface BurikoMoviePcmRequest {
  readonly id: number;
  readonly command: BurikoMoviePcmCommand;
}
export type BurikoMoviePcmResponse =
  | {kind: 'reply'; id: number; status: BurikoMoviePcmStatus}
  | {kind: 'complete'; status: BurikoMoviePcmStatus}
  | {kind: 'progress'; status: BurikoMoviePcmStatus}
  | {kind: 'error'; id: number; message: string}
  | {kind: 'failure'; message: string};

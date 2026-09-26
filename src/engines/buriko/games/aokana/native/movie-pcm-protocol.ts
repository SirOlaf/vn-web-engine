import type {AokanaIsoRational} from './movie-iso-timeline.js';
import type {AokanaMovieAudioSpan} from './movie-audio-samples.js';
export interface AokanaMoviePcmFormat {
  readonly channels: 1 | 2;
  readonly capacityFrames: number;
}
export type AokanaMoviePcmCommand =
  | {kind: 'enqueue'; generation: number; span: AokanaMovieAudioSpan}
  | {kind: 'commit'; generation: number; through: AokanaIsoRational}
  | {kind: 'run' | 'pause' | 'dispose'; generation: number}
  | {kind: 'gain'; generation: number; decibels: number}
  | {kind: 'flush'; generation: number; position: AokanaIsoRational}
  | {kind: 'end'; generation: number; position: AokanaIsoRational}
  | {kind: 'status'};
export interface AokanaMoviePcmStatus {
  readonly result: 'ok' | 'would-block' | 'stale';
  readonly generation: number;
  readonly position: AokanaIsoRational;
  readonly committedThrough: AokanaIsoRational;
  readonly stop: AokanaIsoRational | null;
  readonly consumedFrames: bigint;
  readonly retainedFrames: number;
  readonly availableFrames: number;
  readonly running: boolean;
  readonly ended: boolean;
}
export interface AokanaMoviePcmRequest {
  readonly id: number;
  readonly command: AokanaMoviePcmCommand;
}
export type AokanaMoviePcmResponse =
  | {kind: 'reply'; id: number; status: AokanaMoviePcmStatus}
  | {kind: 'complete'; status: AokanaMoviePcmStatus}
  | {kind: 'progress'; status: AokanaMoviePcmStatus}
  | {kind: 'error'; id: number; message: string}
  | {kind: 'failure'; message: string};

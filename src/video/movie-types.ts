import type {YuvFrame} from './frame.js';

export interface MovieInfo {
  width: number;
  height: number;
  frameRate: number;
  frameCount: number;
  duration: number;
  sampleRate: number;
  channels: number;
  sampleCount: number;
  videoEndTime?: number;
  /** Silence before the first audio access unit is already known from the index. */
  audioStartTime?: number;
  audioEndTime?: number;
}
export interface MovieFrame extends YuvFrame {
  /** Presentation time in seconds from the common movie origin. */
  timestamp?: number;
  duration?: number;
}
export interface MoviePcm {
  start: number;
  channels: Float32Array[];
  /** Presentation time; absent for sample-index-based containers. */
  timestamp?: number;
}
export interface MovieBatch {
  frames: MovieFrame[];
  audio: MoviePcm[];
  info?: MovieInfo;
  done: boolean;
  progress: number;
}
export interface MovieStream {
  readonly info?: MovieInfo;
  next(): Promise<MovieBatch>;
}

import type {BurikoDecodedMovieAudio} from './movie-audio-decoder.js';
import {BurikoIsoSampleError, type BurikoIsoTrack} from './movie-iso-samples.js';
import {
  burikoIsoTime as time,
  type BurikoIsoRational,
  type BurikoIsoTimeline,
  type BurikoIsoEditSegment,
} from './movie-iso-timeline.js';

export interface BurikoMovieAudioSpan {
  readonly planes: readonly Float32Array[];
  readonly sampleRate: number;
  readonly frameCount: number;
  readonly firstFrame: number;
  readonly endFrame: number;
  readonly editIndex: number;
  readonly start: BurikoIsoRational;
  readonly end: BurikoIsoRational;
}
function ceil(value: BurikoIsoRational): bigint {
  const quotient = value.numerator / value.denominator;
  return quotient + (value.numerator % value.denominator > 0n ? 1n : 0n);
}
function validateEdit(edit: BurikoIsoEditSegment): void {
  if (edit.mediaTime !== -1n && edit.rate !== 65536)
    throw new BurikoIsoSampleError('The installed movie audio profile requires unit-rate edits');
}
function prepareChunk(chunk: BurikoDecodedMovieAudio, track: BurikoIsoTrack) {
  if (
    !Number.isSafeInteger(chunk.sampleRate) ||
    chunk.sampleRate <= 0 ||
    !Number.isSafeInteger(chunk.frameCount) ||
    chunk.frameCount < 0 ||
    chunk.planes.length === 0 ||
    chunk.planes.some((plane) => plane.length !== chunk.frameCount) ||
    !Number.isSafeInteger(track.timescale) ||
    track.timescale <= 0
  )
    throw new BurikoIsoSampleError('Movie PCM span has inconsistent decoded dimensions');
  const source = time.fraction(chunk.mediaStart.numerator, chunk.mediaStart.denominator),
    rate = BigInt(chunk.sampleRate),
    count = BigInt(chunk.frameCount);
  const index = (boundary: BurikoIsoRational): number => {
    const value = ceil(time.scale(time.subtract(boundary, source), rate));
    return Number(value < 0n ? 0n : value > count ? count : value);
  };
  return {source, rate, index};
}
function mapEdit(
  chunk: BurikoDecodedMovieAudio,
  track: BurikoIsoTrack,
  edit: BurikoIsoEditSegment,
  seek: BurikoIsoRational,
  prepared: ReturnType<typeof prepareChunk>,
): BurikoMovieAudioSpan | null {
  if (edit.mediaTime === -1n) return null;
  const {source, rate, index} = prepared;
  const editEnd = time.add(edit.start, edit.duration);
  const clippedStart = time.compare(seek, edit.start) > 0 ? seek : edit.start;
  if (time.compare(clippedStart, editEnd) >= 0) return null;
  const origin = time.fraction(edit.mediaTime, BigInt(track.timescale));
  const firstFrame = index(time.add(origin, time.subtract(clippedStart, edit.start)));
  const endFrame = index(time.add(origin, edit.duration));
  if (firstFrame >= endFrame) return null;
  const movieTime = (frame: number): BurikoIsoRational =>
    time.add(
      edit.start,
      time.subtract(time.add(source, time.fraction(BigInt(frame), rate)), origin),
    );
  return {
    planes: chunk.planes.map((plane) => plane.slice(firstFrame, endFrame)),
    sampleRate: chunk.sampleRate,
    frameCount: endFrame - firstFrame,
    firstFrame,
    endFrame,
    editIndex: edit.index,
    start: movieTime(firstFrame),
    end: movieTime(endFrame),
  };
}
/** One selected actual edit; no copies for other or repeated edits are created. */
export function mapBurikoMovieAudioEdit(
  chunk: BurikoDecodedMovieAudio,
  track: BurikoIsoTrack,
  edit: BurikoIsoEditSegment,
  seek: BurikoIsoRational = time.fraction(0n),
): BurikoMovieAudioSpan | null {
  validateEdit(edit);
  return mapEdit(chunk, track, edit, seek, prepareChunk(chunk, track));
}
/** Installed unit-rate audio edit profile: real frame starts in each half-open interval. */
export function mapBurikoMovieAudioSpan(
  chunk: BurikoDecodedMovieAudio,
  track: BurikoIsoTrack,
  timeline: BurikoIsoTimeline,
  seek: BurikoIsoRational = time.fraction(0n),
): readonly BurikoMovieAudioSpan[] {
  for (const edit of timeline.edits) validateEdit(edit);
  const prepared = prepareChunk(chunk, track);
  const result: BurikoMovieAudioSpan[] = [];
  for (const edit of timeline.edits) {
    const span = mapEdit(chunk, track, edit, seek, prepared);
    if (span !== null) result.push(span);
  }
  return result;
}

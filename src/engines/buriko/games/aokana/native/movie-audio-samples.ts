import type {AokanaDecodedMovieAudio} from './movie-audio-decoder.js';
import {AokanaIsoSampleError, type AokanaIsoTrack} from './movie-iso-samples.js';
import {
  aokanaIsoTime as time,
  type AokanaIsoRational,
  type AokanaIsoTimeline,
  type AokanaIsoEditSegment,
} from './movie-iso-timeline.js';

export interface AokanaMovieAudioSpan {
  readonly planes: readonly Float32Array[];
  readonly sampleRate: number;
  readonly frameCount: number;
  readonly firstFrame: number;
  readonly endFrame: number;
  readonly editIndex: number;
  readonly start: AokanaIsoRational;
  readonly end: AokanaIsoRational;
}
function ceil(value: AokanaIsoRational): bigint {
  const quotient = value.numerator / value.denominator;
  return quotient + (value.numerator % value.denominator > 0n ? 1n : 0n);
}
function validateEdit(edit: AokanaIsoEditSegment): void {
  if (edit.mediaTime !== -1n && edit.rate !== 65536)
    throw new AokanaIsoSampleError('The installed movie audio profile requires unit-rate edits');
}
function prepareChunk(chunk: AokanaDecodedMovieAudio, track: AokanaIsoTrack) {
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
    throw new AokanaIsoSampleError('Movie PCM span has inconsistent decoded dimensions');
  const source = time.fraction(chunk.mediaStart.numerator, chunk.mediaStart.denominator),
    rate = BigInt(chunk.sampleRate),
    count = BigInt(chunk.frameCount);
  const index = (boundary: AokanaIsoRational): number => {
    const value = ceil(time.scale(time.subtract(boundary, source), rate));
    return Number(value < 0n ? 0n : value > count ? count : value);
  };
  return {source, rate, index};
}
function mapEdit(
  chunk: AokanaDecodedMovieAudio,
  track: AokanaIsoTrack,
  edit: AokanaIsoEditSegment,
  seek: AokanaIsoRational,
  prepared: ReturnType<typeof prepareChunk>,
): AokanaMovieAudioSpan | null {
  if (edit.mediaTime === -1n) return null;
  const {source, rate, index} = prepared;
  const editEnd = time.add(edit.start, edit.duration);
  const clippedStart = time.compare(seek, edit.start) > 0 ? seek : edit.start;
  if (time.compare(clippedStart, editEnd) >= 0) return null;
  const origin = time.fraction(edit.mediaTime, BigInt(track.timescale));
  const firstFrame = index(time.add(origin, time.subtract(clippedStart, edit.start)));
  const endFrame = index(time.add(origin, edit.duration));
  if (firstFrame >= endFrame) return null;
  const movieTime = (frame: number): AokanaIsoRational =>
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
export function mapAokanaMovieAudioEdit(
  chunk: AokanaDecodedMovieAudio,
  track: AokanaIsoTrack,
  edit: AokanaIsoEditSegment,
  seek: AokanaIsoRational = time.fraction(0n),
): AokanaMovieAudioSpan | null {
  validateEdit(edit);
  return mapEdit(chunk, track, edit, seek, prepareChunk(chunk, track));
}
/** Installed unit-rate audio edit profile: real frame starts in each half-open interval. */
export function mapAokanaMovieAudioSpan(
  chunk: AokanaDecodedMovieAudio,
  track: AokanaIsoTrack,
  timeline: AokanaIsoTimeline,
  seek: AokanaIsoRational = time.fraction(0n),
): readonly AokanaMovieAudioSpan[] {
  for (const edit of timeline.edits) validateEdit(edit);
  const prepared = prepareChunk(chunk, track);
  const result: AokanaMovieAudioSpan[] = [];
  for (const edit of timeline.edits) {
    const span = mapEdit(chunk, track, edit, seek, prepared);
    if (span !== null) result.push(span);
  }
  return result;
}

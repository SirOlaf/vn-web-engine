import {
  BurikoIsoSampleError,
  type BurikoIsoEdit,
  type BurikoIsoMovie,
  type BurikoIsoTrack,
} from './movie-iso-samples.js';

/** Exact standard-container time, before conversion to a platform clock unit. */
export interface BurikoIsoRational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

function fraction(numerator: bigint, denominator = 1n): BurikoIsoRational {
  if (denominator === 0n) throw new BurikoIsoSampleError('ISO edit has a zero time denominator');
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  let a = numerator < 0n ? -numerator : numerator,
    b = denominator;
  while (b !== 0n) {
    const next = a % b;
    a = b;
    b = next;
  }
  return {numerator: numerator / a, denominator: denominator / a};
}
const compare = (a: BurikoIsoRational, b: BurikoIsoRational): number => {
  const difference = a.numerator * b.denominator - b.numerator * a.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
};
const add = (a: BurikoIsoRational, b: BurikoIsoRational): BurikoIsoRational =>
  fraction(
    a.numerator * b.denominator + b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
const subtract = (a: BurikoIsoRational, b: BurikoIsoRational): BurikoIsoRational =>
  fraction(
    a.numerator * b.denominator - b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
const scale = (a: BurikoIsoRational, numerator: bigint, denominator = 1n): BurikoIsoRational =>
  fraction(a.numerator * numerator, a.denominator * denominator);
const zero = fraction(0n);
export const burikoIsoTime = {fraction, compare, add, subtract, scale};

/** The installed ISO filter profile truncates exact timestamps to 100 ns, once. */
export function burikoIsoReferenceTime(seconds: BurikoIsoRational): bigint {
  return BigInt.asIntN(64, (seconds.numerator * 10000000n) / seconds.denominator);
}

export interface BurikoIsoPresentation {
  readonly sampleIndex: number;
  readonly editIndex: number;
  readonly start: bigint;
  readonly end: bigint;
  /** Exact movie seconds, retaining partial sample boundaries for audio trimming. */
  readonly exactStart: BurikoIsoRational;
  readonly exactEnd: BurikoIsoRational;
  /** Exact source media ticks; descending endpoints denote reverse playback. */
  readonly mediaStart: BurikoIsoRational;
  readonly mediaEnd: BurikoIsoRational;
  readonly rate: number;
}

export interface BurikoIsoTimeline {
  readonly duration: bigint;
  readonly exactDuration: BurikoIsoRational;
  readonly presentations: readonly BurikoIsoPresentation[];
  readonly edits: readonly BurikoIsoEditSegment[];
}

export interface BurikoIsoEditSegment {
  readonly index: number;
  readonly start: BurikoIsoRational;
  readonly duration: BurikoIsoRational;
  readonly mediaTime: bigint;
  readonly rate: number;
}

/**
 * ISO edit mapping for this browser splitter. Empty edits create gaps; dwell,
 * positive and negative 16.16 rates retain their real source intervals. Decoder
 * preroll still follows sample decode order, separately from this presentation plan.
 */
export function createBurikoIsoTimeline(
  movie: BurikoIsoMovie,
  track: BurikoIsoTrack,
): BurikoIsoTimeline {
  const movieScale = BigInt(movie.timescale),
    mediaScale = BigInt(track.timescale);
  if (movieScale <= 0n || mediaScale <= 0n)
    throw new BurikoIsoSampleError('ISO timeline has a zero timescale');
  let inferredEnd = 0n;
  for (const sample of track.samples) {
    const end = sample.compositionTime + BigInt(sample.duration);
    if (end > inferredEnd) inferredEnd = end;
  }
  const knownDuration = (value: bigint): boolean =>
    value > 0n && value !== 0xffffffffn && value !== 0xffffffffffffffffn;
  const implicitDuration = knownDuration(track.movieDuration)
    ? fraction(track.movieDuration, movieScale)
    : knownDuration(track.duration)
      ? fraction(track.duration, mediaScale)
      : fraction(inferredEnd, mediaScale);
  const edits: readonly BurikoIsoEdit[] =
    track.edits.length === 0 ? [{duration: 0n, mediaTime: 0n, rate: 0x10000}] : track.edits;
  const presentations: BurikoIsoPresentation[] = [];
  const segments: BurikoIsoEditSegment[] = [];
  let elapsed = zero;
  for (let editIndex = 0; editIndex < edits.length; editIndex++) {
    const edit = edits[editIndex]!;
    if (edit.mediaTime < -1n)
      throw new BurikoIsoSampleError('ISO edit has an invalid negative media time');
    const duration =
      track.edits.length === 0 ? implicitDuration : fraction(edit.duration, movieScale);
    if (duration.numerator < 0n) throw new BurikoIsoSampleError('ISO edit has a negative duration');
    const mediaOrigin = fraction(edit.mediaTime);
    const rate = edit.rate | 0;
    segments.push({index: editIndex, start: elapsed, duration, mediaTime: edit.mediaTime, rate});
    if (edit.mediaTime !== -1n && (duration.numerator !== 0n || track.edits.length === 0)) {
      let dwellSelected = false;
      for (let sampleIndex = 0; sampleIndex < track.samples.length; sampleIndex++) {
        const sample = track.samples[sampleIndex]!;
        const mediaBegin = fraction(sample.compositionTime),
          mediaFinish = fraction(sample.compositionTime + BigInt(sample.duration));
        let begin: BurikoIsoRational, finish: BurikoIsoRational;
        if (rate === 0) {
          if (
            dwellSelected ||
            compare(mediaBegin, mediaOrigin) > 0 ||
            compare(mediaOrigin, mediaFinish) >= 0
          )
            continue;
          dwellSelected = true;
          begin = zero;
          finish = duration;
        } else {
          const first = scale(subtract(mediaBegin, mediaOrigin), 65536n, mediaScale * BigInt(rate));
          const last = scale(subtract(mediaFinish, mediaOrigin), 65536n, mediaScale * BigInt(rate));
          const left = rate > 0 ? first : last,
            right = rate > 0 ? last : first;
          const point = sample.duration === 0;
          if (
            point
              ? compare(left, zero) < 0 || compare(left, duration) > 0
              : compare(right, zero) <= 0 || compare(left, duration) >= 0
          )
            continue;
          begin = compare(left, zero) < 0 ? zero : left;
          finish = compare(right, duration) > 0 ? duration : right;
        }
        const exactStart = add(elapsed, begin),
          exactEnd = add(elapsed, finish);
        const sourceAt = (time: BurikoIsoRational): BurikoIsoRational =>
          add(mediaOrigin, scale(time, mediaScale * BigInt(rate), 65536n));
        presentations.push({
          sampleIndex,
          editIndex,
          start: burikoIsoReferenceTime(exactStart),
          end: burikoIsoReferenceTime(exactEnd),
          exactStart,
          exactEnd,
          mediaStart: sourceAt(begin),
          mediaEnd: sourceAt(finish),
          rate,
        });
      }
    }
    elapsed = add(elapsed, duration);
  }
  presentations.sort(
    (a, b) =>
      compare(a.exactStart, b.exactStart) ||
      a.editIndex - b.editIndex ||
      a.sampleIndex - b.sampleIndex,
  );
  return {
    duration: burikoIsoReferenceTime(elapsed),
    exactDuration: elapsed,
    presentations,
    edits: segments,
  };
}

/** A decode seek starts at the latest preceding sync sample, including codec preroll. */
export function burikoIsoDecodeStart(track: BurikoIsoTrack, sampleIndex: number): number {
  if (!Number.isInteger(sampleIndex) || sampleIndex < 0 || sampleIndex >= track.samples.length)
    throw new BurikoIsoSampleError('ISO decoder seeks outside its sample table');
  for (let index = sampleIndex; index >= 0; index--) if (track.samples[index]!.sync) return index;
  throw new BurikoIsoSampleError('ISO decoder has no preceding random-access sample');
}

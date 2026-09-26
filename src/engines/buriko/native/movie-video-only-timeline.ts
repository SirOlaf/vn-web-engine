import {BurikoMovieSourceTracks} from './movie-source-tracks.js';
import {BurikoMovieReferenceClock} from './movie-render-events.js';
import {
  burikoIsoReferenceTime,
  burikoIsoTime as time,
  type BurikoIsoRational,
} from './movie-iso-timeline.js';

const referenceUnitsPerSecond = 10000000n;
const maximumReferenceTime = 0x7fffffffffffffffn;

/** One selected video-only edit timeline anchored to the actual graph reference clock.
 * This owner creates no decoder, ReceivePin, renderer or presentation task. */
export class BurikoMovieVideoOnlyTimeline {
  readonly stop: BurikoIsoRational;
  readonly stopTime: bigint;
  private pausedPosition = time.fraction(0n);
  private start: bigint | null = null;
  private lastRaw: bigint | null = null;
  private seekGeneration = 0;
  private closed = false;

  constructor(
    readonly tracks: BurikoMovieSourceTracks,
    readonly clock: BurikoMovieReferenceClock,
  ) {
    if (
      !(tracks instanceof BurikoMovieSourceTracks) ||
      tracks.audio !== null ||
      !(clock instanceof BurikoMovieReferenceClock)
    )
      throw new TypeError(
        'Video-only timeline requires selected source tracks and reference clock',
      );
    this.stop = Object.freeze(
      time.fraction(
        tracks.video.timeline.exactDuration.numerator,
        tracks.video.timeline.exactDuration.denominator,
      ),
    );
    const ticks = (this.stop.numerator * referenceUnitsPerSecond) / this.stop.denominator;
    if (ticks < 0n || ticks > maximumReferenceTime)
      throw new RangeError('Selected video-only duration exceeds signed reference time');
    this.stopTime = burikoIsoReferenceTime(this.stop);
  }

  get generation(): number {
    return this.seekGeneration;
  }

  get state(): 'paused' | 'running' | 'closed' {
    return this.closed ? 'closed' : this.start === null ? 'paused' : 'running';
  }

  /** The exact paused seek survives until real clock advancement quantizes it to 100 ns. */
  get position(): BurikoIsoRational {
    this.check();
    return this.start === null
      ? time.fraction(this.pausedPosition.numerator, this.pausedPosition.denominator)
      : time.fraction(this.currentTime, referenceUnitsPerSecond);
  }

  get graphStart(): bigint | null {
    return this.start;
  }

  private check(): void {
    if (this.closed) throw new Error('Video-only timeline is closed');
  }

  private raw(): bigint {
    const now = this.clock.now();
    if (now < 0n || (this.lastRaw !== null && now < this.lastRaw))
      throw new Error('Video-only timeline requires a monotonic reference clock');
    this.lastRaw = now;
    return now;
  }

  /** Absolute movie 100-ns time; it may pass stop while real Receive EOS resolves. */
  get currentTime(): bigint {
    this.check();
    return this.start === null
      ? burikoIsoReferenceTime(this.pausedPosition)
      : this.raw() - this.start;
  }

  /** Return the exact offset to pass into ReceivePin.run(graphStart). */
  run(): bigint {
    this.check();
    if (this.start !== null) return this.start;
    this.start = this.raw() - burikoIsoReferenceTime(this.pausedPosition);
    return this.start;
  }

  /** Freeze actual elapsed reference time, excluding the subsequent host pause. */
  pause(): bigint {
    this.check();
    if (this.start !== null) {
      this.pausedPosition = time.fraction(this.raw() - this.start, referenceUnitsPerSecond);
      this.start = null;
    }
    return burikoIsoReferenceTime(this.pausedPosition);
  }

  /** Future transport must quiesce its old Receive epoch before calling seek. */
  seek(position: BurikoIsoRational): bigint {
    this.check();
    if (this.start !== null) throw new Error('Video-only timeline seek requires a paused epoch');
    const selected = time.fraction(position.numerator, position.denominator);
    if (time.compare(selected, time.fraction(0n)) < 0 || time.compare(selected, this.stop) > 0)
      throw new RangeError('Video-only seek exceeds the selected track timeline');
    if (this.seekGeneration === Number.MAX_SAFE_INTEGER)
      throw new RangeError('Video-only seek generation is exhausted');
    this.pausedPosition = selected;
    this.seekGeneration++;
    return burikoIsoReferenceTime(selected);
  }

  dispose(): void {
    if (this.closed) return;
    this.start = null;
    this.closed = true;
  }
}

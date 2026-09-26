import {BurikoMovieAudioDecoder, type BurikoMovieAudioOutputLimits} from './movie-audio-decoder.js';
import {mapBurikoMovieAudioEdit, type BurikoMovieAudioSpan} from './movie-audio-samples.js';
import {
  BurikoIsoSampleError,
  type BurikoIsoMovie,
  type BurikoIsoTrack,
} from './movie-iso-samples.js';
import {
  burikoIsoTime as time,
  type BurikoIsoRational,
  type BurikoIsoTimeline,
} from './movie-iso-timeline.js';
import {BurikoBrowserMoviePcmOutput, BurikoMemoryMoviePcmOutput} from './movie-pcm-output.js';
import type {BurikoMoviePcmCommand, BurikoMoviePcmStatus} from './movie-pcm-protocol.js';

/** Extension preserves selected sample-frame tails; it is not a strict nominal audio cut-off. */
export interface BurikoMovieAudioCommonStop {
  readonly policy: 'retain-frame-support';
  readonly stop: BurikoIsoRational;
}

type Output = BurikoMemoryMoviePcmOutput | BurikoBrowserMoviePcmOutput;
export type BurikoMovieAudioProducerStep =
  | {readonly kind: 'advanced' | 'submitted-end'; readonly generation: number}
  | {
      readonly kind: 'capacity-wait';
      readonly generation: number;
      readonly requiredAvailableFrames: number;
    };
interface RetainedSpan {
  readonly end: BurikoIsoRational;
  readonly frames: number;
}
const exact = (value: BurikoIsoRational): BurikoIsoRational =>
  time.fraction(value.numerator, value.denominator);

/**
 * Restricted browser producer: actual decoded starts must be nondecreasing per
 * reset. This is an enforced supported profile, not a WebCodecs guarantee.
 * Owns enqueue/commit/end only; transport must cancelAndJoin before output flush.
 */
export class BurikoMovieAudioProducer {
  private editIndex = 0;
  private editStarted = false;
  private previousStart: BurikoIsoRational | null = null;
  private pending: BurikoMovieAudioSpan | null = null;
  private retained: RetainedSpan[] = [];
  private through: BurikoIsoRational;
  private readonly interimLimit: BurikoIsoRational;
  private submittedEnd = false;
  private canceled = false;
  private failure: unknown = null;
  private inFlight: Promise<BurikoMovieAudioProducerStep> | null = null;
  private readonly cancellation = new DOMException(
    'Movie audio producer was canceled',
    'AbortError',
  );

  private constructor(
    private readonly decoder: BurikoMovieAudioDecoder,
    private readonly track: BurikoIsoTrack,
    private readonly timeline: BurikoIsoTimeline,
    private readonly output: Output,
    readonly generation: number,
    private readonly seek: BurikoIsoRational,
    private readonly stop: BurikoIsoRational,
  ) {
    this.through = seek;
    const remaining = time.scale(time.subtract(stop, seek), BigInt(output.outputSampleRate));
    const frames =
      remaining.numerator / remaining.denominator +
      (remaining.numerator % remaining.denominator > 0n ? 1n : 0n);
    // Keep the last sample uncommitted until atomic end installs the exact stop.
    this.interimLimit =
      frames === 0n
        ? seek
        : time.add(seek, time.fraction(frames - 1n, BigInt(output.outputSampleRate)));
  }

  static async create(
    movie: BurikoIsoMovie,
    track: BurikoIsoTrack,
    timeline: BurikoIsoTimeline,
    output: Output,
    limits: BurikoMovieAudioOutputLimits,
    generation: number,
    seek: BurikoIsoRational = time.fraction(0n),
    commonStop?: BurikoMovieAudioCommonStop,
  ): Promise<BurikoMovieAudioProducer> {
    if (
      !(output instanceof BurikoMemoryMoviePcmOutput) &&
      !(output instanceof BurikoBrowserMoviePcmOutput)
    )
      throw new BurikoIsoSampleError('Movie producer requires an actual PCM output owner');
    if (commonStop !== undefined && commonStop.policy !== 'retain-frame-support')
      throw new BurikoIsoSampleError(
        'Movie common stop requires explicit retained-frame-support policy',
      );
    const stop = exact(commonStop?.stop ?? timeline.exactDuration);
    if (time.compare(stop, timeline.exactDuration) < 0)
      throw new BurikoIsoSampleError('Movie common stop cannot precede the audio timeline');
    const origin = exact(seek),
      copiedLimits = {...limits},
      format = output.outputFormat;
    if (
      !Number.isSafeInteger(generation) ||
      generation < 0 ||
      time.compare(origin, time.fraction(0n)) < 0 ||
      time.compare(origin, stop) > 0
    )
      throw new BurikoIsoSampleError('Movie producer has an invalid generation or absolute seek');
    for (const edit of timeline.edits)
      if (edit.mediaTime !== -1n && edit.rate !== 65536)
        throw new BurikoIsoSampleError('Movie producer requires unit-rate nonempty edits');
    if (
      copiedLimits.channels !== format.channels ||
      copiedLimits.maxChunkFrames > format.capacityFrames
    )
      throw new BurikoIsoSampleError('Movie decoder and actual output budgets are incompatible');
    const validateFresh = (status: BurikoMoviePcmStatus): void => {
      if (
        status.result !== 'ok' ||
        status.generation !== generation ||
        status.running ||
        status.ended ||
        status.consumedFrames !== 0n ||
        status.retainedFrames !== 0 ||
        status.stop !== null ||
        time.compare(status.committedThrough, origin) !== 0 ||
        time.compare(status.position, origin) !== 0
      )
        throw new BurikoIsoSampleError(
          'Movie producer requires a fresh paused PCM generation at its seek',
        );
    };
    validateFresh(await output.command({kind: 'status'}));
    const decoder = await BurikoMovieAudioDecoder.create(movie, track, copiedLimits);
    try {
      // Negotiate asynchronously, then recheck the actual output before handing ownership over.
      validateFresh(await output.command({kind: 'status'}));
      return new BurikoMovieAudioProducer(
        decoder,
        track,
        timeline,
        output,
        generation,
        origin,
        stop,
      );
    } catch (error) {
      decoder.dispose();
      throw error;
    }
  }

  private check(): void {
    if (this.failure !== null) throw this.failure;
    if (this.canceled) throw this.cancellation;
  }
  private accept(
    status: BurikoMoviePcmStatus,
    allowBlocked = false,
    enqueued?: BurikoMovieAudioSpan,
  ): BurikoMoviePcmStatus {
    if (
      status.generation !== this.generation ||
      (status.result !== 'ok' && !(allowBlocked && status.result === 'would-block'))
    )
      throw new BurikoIsoSampleError(
        'Movie producer received an unapplied or foreign-generation acknowledgment',
      );
    const added = status.result === 'ok' ? enqueued : undefined;
    let removed =
      this.retained.reduce((sum, span) => sum + span.frames, added?.frameCount ?? 0) -
      status.retainedFrames;
    if (removed < 0)
      throw new BurikoIsoSampleError('Movie output contains allocations not owned by its producer');
    // Position alone does not retire a just-enqueued past span: only actual render does.
    this.retained = this.retained.filter((span) => {
      if (removed > 0 && time.compare(span.end, status.position) <= 0) {
        if (span.frames > removed)
          throw new BurikoIsoSampleError(
            'Movie output retirement does not match whole owned spans',
          );
        removed -= span.frames;
        return false;
      }
      return true;
    });
    if (removed !== 0)
      throw new BurikoIsoSampleError('Movie output retirement exceeds eligible owned spans');
    if (added !== undefined) this.retained.push({end: added.end, frames: added.frameCount});
    return status;
  }
  private async command(
    command: BurikoMoviePcmCommand,
    allowBlocked = false,
  ): Promise<BurikoMoviePcmStatus> {
    this.check();
    const status = this.accept(
      await this.output.command(command),
      allowBlocked,
      command.kind === 'enqueue' ? command.span : undefined,
    );
    this.check(); // A posted browser command must settle before cancellation can join.
    return status;
  }
  private result(kind: 'advanced' | 'submitted-end'): BurikoMovieAudioProducerStep {
    return {kind, generation: this.generation};
  }
  private async commit(bound: BurikoIsoRational): Promise<void> {
    if (time.compare(bound, this.interimLimit) > 0) bound = this.interimLimit;
    if (time.compare(bound, this.through) <= 0) return;
    if (time.compare(bound, this.stop) >= 0)
      throw new BurikoIsoSampleError('Final movie coverage requires atomic end publication');
    await this.command({kind: 'commit', generation: this.generation, through: bound});
    this.through = bound;
  }
  private async end(): Promise<BurikoMovieAudioProducerStep> {
    await this.command({
      kind: 'end',
      generation: this.generation,
      position: this.stop,
    });
    this.through = this.stop;
    this.submittedEnd = true;
    return this.result('submitted-end');
  }
  private async closeEdit(end: BurikoIsoRational): Promise<BurikoMovieAudioProducerStep> {
    this.editIndex++;
    this.editStarted = false;
    this.previousStart = null;
    if (time.compare(end, this.timeline.exactDuration) >= 0) return this.end();
    await this.commit(end);
    return this.result('advanced');
  }
  private capacityWait(
    status: BurikoMoviePcmStatus,
    span: BurikoMovieAudioSpan,
  ): BurikoMovieAudioProducerStep {
    let releasable = 0;
    for (const retained of this.retained)
      if (time.compare(retained.end, this.through) <= 0) releasable += retained.frames;
    if (status.availableFrames + releasable < span.frameCount)
      throw new BurikoIsoSampleError(
        'Movie whole-span output budget cannot progress within committed coverage',
      );
    return {
      kind: 'capacity-wait',
      generation: this.generation,
      requiredAvailableFrames: span.frameCount,
    };
  }
  private async publishPending(): Promise<BurikoMovieAudioProducerStep> {
    const span = this.pending!;
    const status = await this.command({kind: 'status'});
    if (status.availableFrames < span.frameCount) return this.capacityWait(status, span);
    const reply = await this.command({kind: 'enqueue', generation: this.generation, span}, true);
    if (reply.result === 'would-block') return this.capacityWait(reply, span);
    this.pending = null;
    return this.result('advanced');
  }
  private async performStep(): Promise<BurikoMovieAudioProducerStep> {
    this.check();
    if (this.submittedEnd) return this.result('submitted-end');
    if (this.pending !== null) return this.publishPending();
    const edit = this.timeline.edits[this.editIndex];
    if (edit === undefined || time.compare(this.seek, this.stop) === 0) return this.end();
    const editEnd = time.add(edit.start, edit.duration);
    if (time.compare(editEnd, this.seek) <= 0) {
      this.editIndex++;
      return this.result('advanced');
    }
    if (edit.mediaTime === -1n) return this.closeEdit(editEnd);
    if (!this.editStarted) {
      this.decoder.reset();
      this.editStarted = true;
      this.previousStart = null;
    }
    const chunk = await this.decoder.next();
    this.check();
    if (chunk === null) return this.closeEdit(editEnd);
    const start = exact(chunk.mediaStart);
    if (this.previousStart !== null && time.compare(start, this.previousStart) < 0)
      throw new BurikoIsoSampleError(
        'Actual movie audio starts violate the nondecreasing output profile',
      );
    this.previousStart = start;
    const sourceOrigin = time.fraction(edit.mediaTime, BigInt(this.track.timescale));
    if (time.compare(start, time.add(sourceOrigin, edit.duration)) >= 0)
      return this.closeEdit(editEnd);
    let bound = time.add(edit.start, time.subtract(start, sourceOrigin));
    if (time.compare(bound, edit.start) < 0) bound = edit.start;
    if (time.compare(bound, this.seek) < 0) bound = this.seek;
    await this.commit(bound);
    this.check();
    this.pending = mapBurikoMovieAudioEdit(chunk, this.track, edit, this.seek);
    return this.pending === null ? this.result('advanced') : this.publishPending();
  }

  /** At most one actual next() per step. No internal capacity polling or decoder stand-in. */
  step(): Promise<BurikoMovieAudioProducerStep> {
    this.check();
    if (this.inFlight !== null) throw new Error('Concurrent movie audio producer steps');
    const work = this.performStep().catch((error: unknown) => {
      if (this.canceled && error instanceof DOMException && error.name === 'AbortError')
        throw this.cancellation;
      if (error !== this.cancellation) this.failure ??= error;
      throw error;
    });
    this.inFlight = work;
    return work.finally(() => {
      if (this.inFlight === work) this.inFlight = null;
    });
  }
  /** Terminal; transport may flush/dispose output only after this joins posted acknowledgments. */
  async cancelAndJoin(): Promise<void> {
    if (!this.canceled) {
      this.canceled = true;
      try {
        this.decoder.dispose();
      } catch (error) {
        this.failure ??= error;
      }
    }
    try {
      await this.inFlight;
    } catch (error) {
      if (error !== this.cancellation) this.failure ??= error;
    }
    this.pending = null;
    this.retained = [];
    if (this.failure !== null) throw this.failure;
  }
}

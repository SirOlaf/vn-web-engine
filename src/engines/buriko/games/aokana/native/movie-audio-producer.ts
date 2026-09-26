import {AokanaMovieAudioDecoder, type AokanaMovieAudioOutputLimits} from './movie-audio-decoder.js';
import {mapAokanaMovieAudioEdit, type AokanaMovieAudioSpan} from './movie-audio-samples.js';
import {
  AokanaIsoSampleError,
  type AokanaIsoMovie,
  type AokanaIsoTrack,
} from './movie-iso-samples.js';
import {
  aokanaIsoTime as time,
  type AokanaIsoRational,
  type AokanaIsoTimeline,
} from './movie-iso-timeline.js';
import {AokanaBrowserMoviePcmOutput, AokanaMemoryMoviePcmOutput} from './movie-pcm-output.js';
import type {AokanaMoviePcmCommand, AokanaMoviePcmStatus} from './movie-pcm-protocol.js';

/** Extension preserves selected sample-frame tails; it is not a strict nominal audio cut-off. */
export interface AokanaMovieAudioCommonStop {
  readonly policy: 'retain-frame-support';
  readonly stop: AokanaIsoRational;
}

type Output = AokanaMemoryMoviePcmOutput | AokanaBrowserMoviePcmOutput;
export type AokanaMovieAudioProducerStep =
  | {readonly kind: 'advanced' | 'submitted-end'; readonly generation: number}
  | {
      readonly kind: 'capacity-wait';
      readonly generation: number;
      readonly requiredAvailableFrames: number;
    };
interface RetainedSpan {
  readonly end: AokanaIsoRational;
  readonly frames: number;
}
const exact = (value: AokanaIsoRational): AokanaIsoRational =>
  time.fraction(value.numerator, value.denominator);

/**
 * Restricted browser producer: actual decoded starts must be nondecreasing per
 * reset. This is an enforced supported profile, not a WebCodecs guarantee.
 * Owns enqueue/commit/end only; transport must cancelAndJoin before output flush.
 */
export class AokanaMovieAudioProducer {
  private editIndex = 0;
  private editStarted = false;
  private previousStart: AokanaIsoRational | null = null;
  private pending: AokanaMovieAudioSpan | null = null;
  private retained: RetainedSpan[] = [];
  private through: AokanaIsoRational;
  private readonly interimLimit: AokanaIsoRational;
  private submittedEnd = false;
  private canceled = false;
  private failure: unknown = null;
  private inFlight: Promise<AokanaMovieAudioProducerStep> | null = null;
  private readonly cancellation = new DOMException(
    'Movie audio producer was canceled',
    'AbortError',
  );

  private constructor(
    private readonly decoder: AokanaMovieAudioDecoder,
    private readonly track: AokanaIsoTrack,
    private readonly timeline: AokanaIsoTimeline,
    private readonly output: Output,
    readonly generation: number,
    private readonly seek: AokanaIsoRational,
    private readonly stop: AokanaIsoRational,
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
    movie: AokanaIsoMovie,
    track: AokanaIsoTrack,
    timeline: AokanaIsoTimeline,
    output: Output,
    limits: AokanaMovieAudioOutputLimits,
    generation: number,
    seek: AokanaIsoRational = time.fraction(0n),
    commonStop?: AokanaMovieAudioCommonStop,
  ): Promise<AokanaMovieAudioProducer> {
    if (
      !(output instanceof AokanaMemoryMoviePcmOutput) &&
      !(output instanceof AokanaBrowserMoviePcmOutput)
    )
      throw new AokanaIsoSampleError('Movie producer requires an actual PCM output owner');
    if (commonStop !== undefined && commonStop.policy !== 'retain-frame-support')
      throw new AokanaIsoSampleError(
        'Movie common stop requires explicit retained-frame-support policy',
      );
    const stop = exact(commonStop?.stop ?? timeline.exactDuration);
    if (time.compare(stop, timeline.exactDuration) < 0)
      throw new AokanaIsoSampleError('Movie common stop cannot precede the audio timeline');
    const origin = exact(seek),
      copiedLimits = {...limits},
      format = output.outputFormat;
    if (
      !Number.isSafeInteger(generation) ||
      generation < 0 ||
      time.compare(origin, time.fraction(0n)) < 0 ||
      time.compare(origin, stop) > 0
    )
      throw new AokanaIsoSampleError('Movie producer has an invalid generation or absolute seek');
    for (const edit of timeline.edits)
      if (edit.mediaTime !== -1n && edit.rate !== 65536)
        throw new AokanaIsoSampleError('Movie producer requires unit-rate nonempty edits');
    if (
      copiedLimits.channels !== format.channels ||
      copiedLimits.maxChunkFrames > format.capacityFrames
    )
      throw new AokanaIsoSampleError('Movie decoder and actual output budgets are incompatible');
    const validateFresh = (status: AokanaMoviePcmStatus): void => {
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
        throw new AokanaIsoSampleError(
          'Movie producer requires a fresh paused PCM generation at its seek',
        );
    };
    validateFresh(await output.command({kind: 'status'}));
    const decoder = await AokanaMovieAudioDecoder.create(movie, track, copiedLimits);
    try {
      // Negotiate asynchronously, then recheck the actual output before handing ownership over.
      validateFresh(await output.command({kind: 'status'}));
      return new AokanaMovieAudioProducer(
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
    status: AokanaMoviePcmStatus,
    allowBlocked = false,
    enqueued?: AokanaMovieAudioSpan,
  ): AokanaMoviePcmStatus {
    if (
      status.generation !== this.generation ||
      (status.result !== 'ok' && !(allowBlocked && status.result === 'would-block'))
    )
      throw new AokanaIsoSampleError(
        'Movie producer received an unapplied or foreign-generation acknowledgment',
      );
    const added = status.result === 'ok' ? enqueued : undefined;
    let removed =
      this.retained.reduce((sum, span) => sum + span.frames, added?.frameCount ?? 0) -
      status.retainedFrames;
    if (removed < 0)
      throw new AokanaIsoSampleError('Movie output contains allocations not owned by its producer');
    // Position alone does not retire a just-enqueued past span: only actual render does.
    this.retained = this.retained.filter((span) => {
      if (removed > 0 && time.compare(span.end, status.position) <= 0) {
        if (span.frames > removed)
          throw new AokanaIsoSampleError(
            'Movie output retirement does not match whole owned spans',
          );
        removed -= span.frames;
        return false;
      }
      return true;
    });
    if (removed !== 0)
      throw new AokanaIsoSampleError('Movie output retirement exceeds eligible owned spans');
    if (added !== undefined) this.retained.push({end: added.end, frames: added.frameCount});
    return status;
  }
  private async command(
    command: AokanaMoviePcmCommand,
    allowBlocked = false,
  ): Promise<AokanaMoviePcmStatus> {
    this.check();
    const status = this.accept(
      await this.output.command(command),
      allowBlocked,
      command.kind === 'enqueue' ? command.span : undefined,
    );
    this.check(); // A posted browser command must settle before cancellation can join.
    return status;
  }
  private result(kind: 'advanced' | 'submitted-end'): AokanaMovieAudioProducerStep {
    return {kind, generation: this.generation};
  }
  private async commit(bound: AokanaIsoRational): Promise<void> {
    if (time.compare(bound, this.interimLimit) > 0) bound = this.interimLimit;
    if (time.compare(bound, this.through) <= 0) return;
    if (time.compare(bound, this.stop) >= 0)
      throw new AokanaIsoSampleError('Final movie coverage requires atomic end publication');
    await this.command({kind: 'commit', generation: this.generation, through: bound});
    this.through = bound;
  }
  private async end(): Promise<AokanaMovieAudioProducerStep> {
    await this.command({
      kind: 'end',
      generation: this.generation,
      position: this.stop,
    });
    this.through = this.stop;
    this.submittedEnd = true;
    return this.result('submitted-end');
  }
  private async closeEdit(end: AokanaIsoRational): Promise<AokanaMovieAudioProducerStep> {
    this.editIndex++;
    this.editStarted = false;
    this.previousStart = null;
    if (time.compare(end, this.timeline.exactDuration) >= 0) return this.end();
    await this.commit(end);
    return this.result('advanced');
  }
  private capacityWait(
    status: AokanaMoviePcmStatus,
    span: AokanaMovieAudioSpan,
  ): AokanaMovieAudioProducerStep {
    let releasable = 0;
    for (const retained of this.retained)
      if (time.compare(retained.end, this.through) <= 0) releasable += retained.frames;
    if (status.availableFrames + releasable < span.frameCount)
      throw new AokanaIsoSampleError(
        'Movie whole-span output budget cannot progress within committed coverage',
      );
    return {
      kind: 'capacity-wait',
      generation: this.generation,
      requiredAvailableFrames: span.frameCount,
    };
  }
  private async publishPending(): Promise<AokanaMovieAudioProducerStep> {
    const span = this.pending!;
    const status = await this.command({kind: 'status'});
    if (status.availableFrames < span.frameCount) return this.capacityWait(status, span);
    const reply = await this.command({kind: 'enqueue', generation: this.generation, span}, true);
    if (reply.result === 'would-block') return this.capacityWait(reply, span);
    this.pending = null;
    return this.result('advanced');
  }
  private async performStep(): Promise<AokanaMovieAudioProducerStep> {
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
      throw new AokanaIsoSampleError(
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
    this.pending = mapAokanaMovieAudioEdit(chunk, this.track, edit, this.seek);
    return this.pending === null ? this.result('advanced') : this.publishPending();
  }

  /** At most one actual next() per step. No internal capacity polling or decoder stand-in. */
  step(): Promise<AokanaMovieAudioProducerStep> {
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

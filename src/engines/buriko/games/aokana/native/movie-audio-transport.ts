import {AokanaMovieAudioProducer, type AokanaMovieAudioCommonStop} from './movie-audio-producer.js';
import type {AokanaMovieAudioOutputLimits} from './movie-audio-decoder.js';
import type {AokanaIsoMovie, AokanaIsoTrack} from './movie-iso-samples.js';
import {
  aokanaIsoTime as time,
  type AokanaIsoRational,
  type AokanaIsoTimeline,
} from './movie-iso-timeline.js';
import {AokanaMoviePcmGraphClock} from './movie-pcm-clock.js';
import {AokanaBrowserMoviePcmOutput, AokanaMemoryMoviePcmOutput} from './movie-pcm-output.js';
import type {AokanaMoviePcmStatus} from './movie-pcm-protocol.js';

/** Observers cannot change owner results or prevent cleanup/other notifications. */
function notifyObserver<T>(listener: (value: T) => void, value: T): void {
  try {
    listener(value);
  } catch {
    /* External observation is not an owner failure. */
  }
}

type Output = AokanaBrowserMoviePcmOutput | AokanaMemoryMoviePcmOutput;

/** Exclusive audio-only transport. It never activates an AudioContext or drives memory render. */
export class AokanaMovieAudioTransport {
  readonly clock: AokanaMoviePcmGraphClock;
  private producer: AokanaMovieAudioProducer | null = null;
  private creation: Promise<AokanaMovieAudioProducer> | null = null;
  private readonly retirements = new Set<Promise<void>>();
  private stepWork: Promise<void> | null = null;
  private transitions: Promise<void> = Promise.resolve();
  private transitionCount = 0;
  private desiredRunning = false;
  private intent = 0;
  private terminal = false;
  private owned = false;
  private failure: unknown = null;
  private cancellation: Promise<void> | null = null;
  private disposal: Promise<void> | null = null;
  private scheduled: MessageChannel | null = null;
  private requiredFrames: number | null = null;
  private submittedEnd = false;
  private completed = false;
  private readonly removers: Array<() => void> = [];
  private readonly completions = new Set<(status: AokanaMoviePcmStatus) => void>();
  private readonly failures = new Set<(error: unknown) => void>();
  private readonly aborted = new DOMException('Movie audio transport canceled', 'AbortError');

  private constructor(
    private readonly movie: AokanaIsoMovie,
    private readonly track: AokanaIsoTrack,
    private readonly timeline: AokanaIsoTimeline,
    private readonly output: Output,
    private readonly limits: AokanaMovieAudioOutputLimits,
    private generation: number,
    private readonly commonStop: AokanaMovieAudioCommonStop | undefined,
  ) {
    this.clock = new AokanaMoviePcmGraphClock(output);
    // Subscribe before every later acknowledgment recheck, including create negotiation.
    this.removers.push(output.onProgress((status) => this.observe(status)));
    this.removers.push(output.onComplete((status) => this.observe(status)));
    if (output instanceof AokanaBrowserMoviePcmOutput)
      this.removers.push(output.onFailure((error) => this.fail(error)));
  }

  static async create(
    movie: AokanaIsoMovie,
    track: AokanaIsoTrack,
    timeline: AokanaIsoTimeline,
    output: Output,
    limits: AokanaMovieAudioOutputLimits,
    generation: number,
    seek: AokanaIsoRational = time.fraction(0n),
    signal?: AbortSignal,
    commonStop?: AokanaMovieAudioCommonStop,
  ): Promise<AokanaMovieAudioTransport> {
    const copiedStop =
      commonStop === undefined
        ? undefined
        : {
            policy: commonStop.policy,
            stop: time.fraction(commonStop.stop.numerator, commonStop.stop.denominator),
          };
    const transport = new AokanaMovieAudioTransport(
      movie,
      track,
      timeline,
      output,
      {...limits},
      generation,
      copiedStop,
    );
    const abort = (): void => {
      transport.terminal = true;
      // Creation itself is not interruptible; the awaited result is joined below.
      void transport.producer
        ?.cancelAndJoin()
        .catch((error: unknown) => transport.recordFailure(error));
    };
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    try {
      transport.check();
      await transport.createProducer(seek);
      transport.check();
      transport.owned = true; // Caller transfers output ownership only on successful return.
      return transport;
    } catch (error) {
      try {
        await transport.producer?.cancelAndJoin();
      } catch (cleanup) {
        transport.recordFailure(cleanup);
      }
      transport.detach();
      throw transport.failure ?? error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  private check(): void {
    if (this.failure !== null) throw this.failure;
    if (this.terminal) throw this.aborted;
  }
  private async createProducer(seek: AokanaIsoRational): Promise<void> {
    this.check();
    const work = AokanaMovieAudioProducer.create(
      this.movie,
      this.track,
      this.timeline,
      this.output,
      this.limits,
      this.generation,
      seek,
      this.commonStop,
    );
    this.creation = work;
    try {
      this.producer = await work;
    } finally {
      if (this.creation === work) this.creation = null;
    }
    this.check();
  }
  private recordFailure(error: unknown): void {
    if (error === this.aborted || this.failure !== null) return;
    this.failure = error;
    for (const listener of [...this.failures]) notifyObserver(listener, error);
  }
  private fail(error: unknown): void {
    this.recordFailure(error);
    this.desiredRunning = false;
    this.cancelSchedule();
    if (this.owned) void this.cancelAndJoin().catch(() => {});
  }
  onFailure(listener: (error: unknown) => void): () => void {
    this.failures.add(listener);
    if (this.failure !== null) notifyObserver(listener, this.failure);
    return () => {
      this.failures.delete(listener);
    };
  }
  onComplete(listener: (status: AokanaMoviePcmStatus) => void): () => void {
    this.completions.add(listener);
    if (this.completed) {
      const status = this.output.acknowledgedStatus;
      if (status?.generation === this.generation && status.ended) notifyObserver(listener, status);
    }
    return () => {
      this.completions.delete(listener);
    };
  }
  /** Identity check for a composed owner, not a caller-provided duration assertion. */
  usesMovie(movie: AokanaIsoMovie): boolean {
    return this.movie === movie;
  }

  /** Actual selected stop, copied so another owner cannot mutate transport policy. */
  get effectiveStop(): AokanaIsoRational {
    const stop = this.commonStop?.stop ?? this.timeline.exactDuration;
    return time.fraction(stop.numerator, stop.denominator);
  }

  get acknowledgedStatus(): AokanaMoviePcmStatus | null {
    return this.output.acknowledgedStatus;
  }

  private applied(status: AokanaMoviePcmStatus, generation = this.generation): void {
    if (status.result !== 'ok' || status.generation !== generation)
      throw new Error('Movie audio transport received an unapplied acknowledgment');
  }
  private observe(status: AokanaMoviePcmStatus): void {
    if (this.terminal || status.generation !== this.generation || status.result !== 'ok') return;
    if (this.submittedEnd && status.ended && !this.completed) {
      this.completed = true;
      for (const listener of [...this.completions]) notifyObserver(listener, status);
    }
    this.schedule();
  }
  private cancelSchedule(): void {
    this.scheduled?.port1.close();
    this.scheduled?.port2.close();
    this.scheduled = null;
  }
  private schedule(): void {
    if (
      !this.owned ||
      this.terminal ||
      this.failure !== null ||
      !this.desiredRunning ||
      this.transitionCount !== 0 ||
      this.stepWork !== null ||
      this.scheduled !== null ||
      this.submittedEnd
    )
      return;
    const status = this.output.acknowledgedStatus;
    if (status === null || status.generation !== this.generation || !status.running) return;
    if (this.requiredFrames !== null && status.availableFrames < this.requiredFrames) return;
    // One step per host task provides fairness even for synchronous memory commands.
    const task = new MessageChannel();
    this.scheduled = task;
    task.port1.onmessage = () => {
      if (this.scheduled !== task) return;
      this.cancelSchedule();
      if (this.terminal || !this.desiredRunning || this.transitionCount !== 0) return;
      this.startStep();
    };
    task.port2.postMessage(null);
  }
  private startStep(): void {
    const producer = this.producer;
    if (producer === null || this.stepWork !== null) return;
    const work = (async () => {
      try {
        const result = await producer.step();
        if (this.terminal || producer !== this.producer) return;
        this.requiredFrames =
          result.kind === 'capacity-wait' ? result.requiredAvailableFrames : null;
        if (result.kind === 'submitted-end') this.submittedEnd = true;
        // Complete can precede the end command's Promise continuation.
        const status = this.output.acknowledgedStatus;
        if (status !== null) this.observe(status);
      } catch (error) {
        if (!this.terminal && producer === this.producer) this.fail(error);
      }
    })();
    this.stepWork = work;
    void work.finally(() => {
      if (this.stepWork === work) this.stepWork = null;
      this.schedule();
    });
  }
  private transition(operation: () => Promise<void>): Promise<void> {
    this.transitionCount++;
    this.cancelSchedule();
    const work = this.transitions.then(async () => {
      this.check();
      await operation();
    });
    const finished = work.finally(() => {
      this.transitionCount--;
      this.schedule();
    });
    // A failed transition must not prevent terminal cleanup from joining the queue.
    this.transitions = finished.catch((error: unknown) => {
      if (!this.terminal) this.fail(error);
      else this.recordFailure(error);
    });
    return finished;
  }
  run(): Promise<void> {
    this.check();
    this.desiredRunning = true;
    const intent = ++this.intent;
    return this.transition(async () => {
      if (intent !== this.intent) return;
      this.check();
      this.applied(await this.output.command({kind: 'run', generation: this.generation}));
      this.check();
    });
  }
  pause(): Promise<void> {
    this.check();
    this.desiredRunning = false;
    ++this.intent;
    this.cancelSchedule();
    return this.transition(async () => {
      this.check();
      this.applied(await this.output.command({kind: 'pause', generation: this.generation}));
      await this.stepWork;
      this.check();
    });
  }
  /** Register detached ownership before cancellation can call observers synchronously. */
  private retireCurrentProducer(): Promise<void> | null {
    const previous = this.producer;
    if (previous === null) return null;
    this.producer = null;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    this.retirements.add(completion);
    void completion.catch(() => {});
    const finish = (): void => {
      resolve();
      this.retirements.delete(completion);
    };
    const failed = (error: unknown): void => {
      // Settle before observers can reenter terminal cleanup and join this owner.
      reject(error);
      this.retirements.delete(completion);
      if (this.terminal) this.recordFailure(error);
      else this.fail(error);
    };
    try {
      void previous.cancelAndJoin().then(finish, failed);
    } catch (error) {
      failed(error);
    }
    return completion;
  }
  private async joinRetirements(): Promise<void> {
    const results = await Promise.allSettled([...this.retirements]);
    for (const result of results)
      if (result.status === 'rejected') this.recordFailure(result.reason);
  }
  seek(position: AokanaIsoRational, resume = this.desiredRunning): Promise<void> {
    this.check();
    const seek = time.fraction(position.numerator, position.denominator);
    if (
      time.compare(seek, time.fraction(0n)) < 0 ||
      time.compare(seek, this.commonStop?.stop ?? this.timeline.exactDuration) > 0
    )
      throw new RangeError('Movie audio seek is outside the timeline');
    this.desiredRunning = resume;
    const intent = ++this.intent;
    this.cancelSchedule();
    // Wake a step held by an earlier queued pause before waiting for that queue.
    const retired = this.retireCurrentProducer();
    return this.transition(async () => {
      this.check();
      await retired;
      this.check();
      this.applied(await this.output.command({kind: 'pause', generation: this.generation}));
      this.check();
      // An earlier queued seek/create may have published another producer meanwhile.
      await this.retireCurrentProducer();
      await this.stepWork;
      this.check();
      const generation = this.generation + 1;
      if (!Number.isSafeInteger(generation)) throw new RangeError('Movie PCM generation exhausted');
      this.applied(
        await this.output.command({kind: 'flush', generation, position: seek}),
        generation,
      );
      this.generation = generation;
      this.requiredFrames = null;
      this.submittedEnd = this.completed = false;
      this.check();
      await this.createProducer(seek);
      this.check();
      if (intent === this.intent && this.desiredRunning) {
        this.applied(await this.output.command({kind: 'run', generation}));
        this.check();
      }
    });
  }
  cancelAndJoin(): Promise<void> {
    if (this.cancellation !== null) return this.cancellation;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    this.cancellation = completion;
    this.terminal = true;
    this.desiredRunning = false;
    ++this.intent;
    this.cancelSchedule();
    // Signal outside the lifecycle queue: a transition may be joining this step.
    this.retireCurrentProducer();
    void (async () => {
      await this.joinRetirements();
      await this.transitions;
      // A creation already negotiating before terminal intent must finish and be closed.
      try {
        await this.creation;
      } catch (error) {
        this.recordFailure(error);
      }
      this.retireCurrentProducer();
      await this.joinRetirements();
      try {
        await this.stepWork;
      } catch (error) {
        this.recordFailure(error);
      }
      if (this.owned) {
        try {
          this.applied(await this.output.command({kind: 'pause', generation: this.generation}));
        } catch (error) {
          this.recordFailure(error);
        }
      }
      this.detach();
      if (this.failure !== null) throw this.failure;
    })().then(resolve, reject);
    return completion;
  }
  private detach(): void {
    for (const remove of this.removers.splice(0)) remove();
  }
  dispose(): Promise<void> {
    if (this.disposal !== null) return this.disposal;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    this.disposal = completion;
    void (async () => {
      try {
        await this.cancelAndJoin();
      } catch (error) {
        this.recordFailure(error);
      }
      try {
        if (this.output instanceof AokanaBrowserMoviePcmOutput)
          await this.output.dispose(this.generation);
        else this.applied(this.output.command({kind: 'dispose', generation: this.generation}));
      } catch (error) {
        this.recordFailure(error);
      } finally {
        this.detach();
        this.producer = null;
        this.completions.clear();
        this.failures.clear();
      }
      if (this.failure !== null) throw this.failure;
    })().then(resolve, reject);
    return completion;
  }
}

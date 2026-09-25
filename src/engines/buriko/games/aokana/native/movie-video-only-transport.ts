import {AokanaMovieVideoOnlyTimeline} from './movie-video-only-timeline.js';
import {AokanaMovieVideoPump, type AokanaMovieVideoPumpResult} from './movie-video-pump.js';
import {AokanaMovieReceivePin} from './movie-receive.js';
import {AokanaMovieFilterEvents, type AokanaMovieFilterEvent} from './movie-filter-events.js';
import {AokanaMovieRenderer} from './movie-renderer.js';
import {AokanaTraditionalMovieRenderer} from './movie-traditional-renderer.js';
import {AokanaWindowMessages} from './window-messages.js';
import type {AokanaMovieVideoOutputLimits} from './movie-video-decoder.js';
import {aokanaIsoTime as time, type AokanaIsoRational} from './movie-iso-timeline.js';

export interface AokanaVideoOnlyMovieEvent extends AokanaMovieFilterEvent {
  readonly generation: number;
}

function observe<T>(callback: (value: T) => void, value: T): void {
  try {
    callback(value);
  } catch {
    /* An external observer does not own transport cleanup or results. */
  }
}
function invoke<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }
}

/** A selected video-only Receive route, still separate from the surface graph adapter.
 * Owns the selected timeline, prepared pump, pin and FilterEvents after successful creation.
 * Renderer/image/device and window messages remain borrowed through disposal.
 */
export class AokanaMovieVideoOnlyTransport {
  private readonly events: AokanaMovieFilterEvents;
  private readonly pin: AokanaMovieReceivePin;
  private pump: AokanaMovieVideoPump | null = null;
  private readonly creationAbort = new AbortController();
  private readonly removers: Array<() => void> = [];
  private readonly eventObservers = new Set<(event: AokanaVideoOnlyMovieEvent) => void>();
  private readonly failureObservers = new Set<(error: unknown) => void>();
  private completion: AokanaVideoOnlyMovieEvent | null = null;
  private generation: number;
  private epoch = 0;
  private intent = 0;
  private seeking = false;
  private desiredRunning = false;
  private started = false;
  private videoEnded = false;
  private publishCompletion = false;
  private owned = false;
  private terminal = false;
  private failure: unknown = null;
  private scheduled: MessageChannel | null = null;
  private eventTask: MessageChannel | null = null;
  private stepWork: Promise<void> | null = null;
  private transitions: Promise<void> = Promise.resolve();
  private transitionCount = 0;
  private cancellation: Promise<void> | null = null;
  private disposal: Promise<void> | null = null;
  private readonly aborted = new DOMException('Video-only movie canceled', 'AbortError');

  private constructor(
    readonly timeline: AokanaMovieVideoOnlyTimeline,
    messages: AokanaWindowMessages,
    renderer: AokanaMovieRenderer | AokanaTraditionalMovieRenderer,
  ) {
    this.generation = timeline.generation;
    this.events = new AokanaMovieFilterEvents(messages);
    // ReceivePin registers itself as the sole renderer. There is no audio token.
    this.pin = new AokanaMovieReceivePin(renderer, this.events, timeline.clock, timeline.clock);
    this.removers.push(this.events.onAvailable(() => this.scheduleEvents()));
  }

  static async create(
    timeline: AokanaMovieVideoOnlyTimeline,
    messages: AokanaWindowMessages,
    renderer: AokanaMovieRenderer | AokanaTraditionalMovieRenderer,
    limits: AokanaMovieVideoOutputLimits,
    maxRgb32Bytes: number,
    signal?: AbortSignal,
  ): Promise<AokanaMovieVideoOnlyTransport> {
    if (
      !(timeline instanceof AokanaMovieVideoOnlyTimeline) ||
      timeline.state !== 'paused' ||
      timeline.tracks.audio !== null ||
      !(messages instanceof AokanaWindowMessages) ||
      (!(renderer instanceof AokanaMovieRenderer) &&
        !(renderer instanceof AokanaTraditionalMovieRenderer))
    )
      throw new Error('Video-only movie requires concrete selected timeline and host owners');
    const position = timeline.position;
    const owner = new AokanaMovieVideoOnlyTransport(timeline, messages, renderer);
    const abort = (): void => {
      owner.terminal = true;
      owner.creationAbort.abort();
    };
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    try {
      owner.check();
      owner.pump = await AokanaMovieVideoPump.createVideoOnly(
        timeline,
        owner.pin,
        {...limits},
        maxRgb32Bytes,
        owner.creationAbort.signal,
      );
      owner.check();
      owner.removers.push(owner.pump.onFailure((error) => owner.fail(error)));
      if (
        timeline.state !== 'paused' ||
        timeline.generation !== owner.generation ||
        time.compare(timeline.position, position) !== 0
      )
        throw new Error('Video-only movie lost its selected paused creation epoch');
      owner.owned = true;
      owner.publishCompletion = true;
      return owner;
    } catch (error) {
      const first = owner.failure ?? error;
      try {
        if (owner.pump !== null) await owner.pump.dispose();
        else owner.pin.dispose();
      } catch (cleanup) {
        owner.recordFailure(cleanup);
      }
      owner.detach();
      owner.events.dispose();
      // Ownership transfers only on successful creation.
      throw first;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  private check(): void {
    if (this.failure !== null) throw this.failure;
    if (this.terminal) throw this.aborted;
  }
  private actualPump(): AokanaMovieVideoPump {
    if (this.pump === null) throw new Error('Video-only movie has no prepared video owner');
    return this.pump;
  }
  get currentTime(): bigint {
    return this.timeline.currentTime;
  }
  get effectiveStop(): AokanaIsoRational {
    return this.timeline.stop;
  }
  get state(): 'paused' | 'running' | 'closed' {
    return this.timeline.state;
  }
  onEvent(observer: (event: AokanaVideoOnlyMovieEvent) => void): () => void {
    this.eventObservers.add(observer);
    if (this.publishCompletion && !this.terminal && this.completion !== null)
      observe(observer, {...this.completion});
    return () => {
      this.eventObservers.delete(observer);
    };
  }
  onFailure(observer: (error: unknown) => void): () => void {
    this.failureObservers.add(observer);
    if (this.failure !== null) observe(observer, this.failure);
    return () => {
      this.failureObservers.delete(observer);
    };
  }
  private recordFailure(error: unknown): void {
    if (
      error === this.aborted ||
      (this.terminal && this.pump?.isCancellation(error)) ||
      this.failure !== null
    )
      return;
    this.failure = error;
    for (const observer of [...this.failureObservers]) observe(observer, error);
  }
  private fail(error: unknown): void {
    this.recordFailure(error);
    this.desiredRunning = false;
    this.cancelStepTask();
    try {
      if (this.timeline.state !== 'closed') this.timeline.pause();
    } catch (clockError) {
      this.recordFailure(clockError);
    }
    if (this.owned) void this.cancelAndJoin().catch(() => {});
    else this.creationAbort.abort();
  }
  private cancelStepTask(): void {
    this.scheduled?.port1.close();
    this.scheduled?.port2.close();
    this.scheduled = null;
  }
  private cancelEventTask(): void {
    this.eventTask?.port1.close();
    this.eventTask?.port2.close();
    this.eventTask = null;
  }
  private scheduleEvents(): void {
    if (this.eventTask !== null || this.terminal) return;
    const task = new MessageChannel();
    this.eventTask = task;
    task.port1.onmessage = () => {
      if (this.eventTask !== task) return;
      this.cancelEventTask();
      this.drainEvents();
    };
    task.port2.postMessage(null);
  }
  private drainEvents(): void {
    for (;;) {
      const event = this.events.take();
      if (event === null) return;
      if (event.code === 1 && (!this.publishCompletion || this.terminal)) continue;
      const value: AokanaVideoOnlyMovieEvent = {...event, generation: this.generation};
      if (event.code === 1) this.completion = value;
      if (event.code === 3)
        this.fail(
          new Error(`Movie renderer error 0x${BigInt.asUintN(32, event.value1).toString(16)}`),
        );
      for (const observer of [...this.eventObservers]) observe(observer, {...value});
    }
  }
  private acceptResult(result: AokanaMovieVideoPumpResult): void {
    if (result.mode !== 'video-only' || result.videoGeneration !== this.generation)
      throw new Error('Video-only movie received a foreign video epoch');
    if (result.kind === 'submitted-video-eos') this.videoEnded = true;
    if (result.kind === 'empty-video-eos' && !this.videoEnded) {
      this.videoEnded = true;
      // The actual selected source ended without connecting the sole registered pin.
      this.events.notify(this.pin, 1);
    }
  }
  private schedule(): void {
    if (
      !this.owned ||
      this.terminal ||
      this.failure !== null ||
      !this.desiredRunning ||
      this.seeking ||
      this.videoEnded ||
      this.transitionCount !== 0 ||
      this.stepWork !== null ||
      this.scheduled !== null
    )
      return;
    const task = new MessageChannel();
    this.scheduled = task;
    task.port1.onmessage = () => {
      if (this.scheduled !== task) return;
      this.cancelStepTask();
      if (this.terminal || !this.desiredRunning || this.seeking || this.transitionCount !== 0)
        return;
      this.startStep();
    };
    task.port2.postMessage(null);
  }
  private startStep(): void {
    const epoch = this.epoch;
    const work = (async () => {
      try {
        const result = await this.actualPump().step();
        if (!this.terminal && epoch === this.epoch) this.acceptResult(result);
      } catch (error) {
        if (
          (this.terminal || epoch !== this.epoch) &&
          error instanceof DOMException &&
          error.name === 'AbortError'
        )
          return;
        this.fail(error);
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
    this.cancelStepTask();
    const work = this.transitions.then(async () => {
      this.check();
      await operation();
    });
    const finished = work.finally(() => {
      this.transitionCount--;
      this.schedule();
    });
    this.transitions = finished.catch((error: unknown) => {
      if (!this.terminal) this.fail(error);
      else this.recordFailure(error);
    });
    return finished;
  }
  private async join(work: readonly Promise<unknown>[]): Promise<void> {
    for (const operation of work)
      void operation.catch((error: unknown) => {
        if (!this.terminal) this.fail(error);
        else this.recordFailure(error);
      });
    const results = await Promise.allSettled(work);
    for (const result of results)
      if (result.status === 'rejected') this.recordFailure(result.reason);
  }
  run(): Promise<void> {
    this.check();
    this.desiredRunning = true;
    const intent = ++this.intent;
    return this.transition(async () => {
      if (intent !== this.intent) return;
      if (
        (!this.started && this.timeline.state !== 'paused') ||
        this.timeline.generation !== this.generation
      )
        throw new Error('Video-only movie run requires its selected paused epoch');
      const graphStart = this.timeline.run();
      try {
        const result = await this.actualPump().runVideoOnly(graphStart);
        this.check();
        this.started = true;
        if (intent === this.intent && this.desiredRunning) this.acceptResult(result);
      } catch (error) {
        if (this.terminal && this.actualPump().isCancellation(error)) return;
        this.recordFailure(error);
        try {
          this.timeline.pause();
        } catch (clockError) {
          this.recordFailure(clockError);
        }
        throw error;
      }
    });
  }
  pause(): Promise<void> {
    this.check();
    this.desiredRunning = false;
    const intent = ++this.intent;
    this.cancelStepTask();
    return this.transition(async () => {
      if (intent !== this.intent) return;
      this.timeline.pause();
      await this.actualPump().pause();
      if (intent !== this.intent) return;
      this.check();
      // Native Receive may remain pending; the pin cancels its clock advise.
    });
  }
  seek(position: AokanaIsoRational, resume = this.desiredRunning): Promise<void> {
    this.check();
    const seek = time.fraction(position.numerator, position.denominator);
    if (time.compare(seek, time.fraction(0n)) < 0 || time.compare(seek, this.effectiveStop) > 0)
      throw new RangeError('Video-only movie seek exceeds its selected stop');
    if (this.seeking) throw new Error('Video-only movie already has a pending seek');
    this.seeking = true;
    this.desiredRunning = resume;
    this.publishCompletion = false;
    const intent = ++this.intent;
    ++this.epoch;
    this.cancelStepTask();
    // Signal flush before joining a clock-dependent Receive or the outer queue.
    const video = invoke(() => this.actualPump().beginSeek(seek));
    void video.catch((error: unknown) => {
      if (!this.terminal) this.fail(error);
    });
    return this.transition(async () => {
      await this.join([video]);
      await this.stepWork;
      this.check();
      this.timeline.pause();
      this.cancelEventTask();
      this.drainEvents();
      this.check();
      this.events.resetCompletion();
      this.completion = null;
      this.timeline.seek(seek);
      await this.actualPump().finishVideoOnlySeek(this.timeline.generation);
      this.check();
      this.generation = this.timeline.generation;
      this.videoEnded = false;
      this.started = false;
      this.publishCompletion = true;
      if (intent === this.intent && this.desiredRunning) {
        const graphStart = this.timeline.run();
        const result = await this.actualPump().runVideoOnly(graphStart);
        this.check();
        this.started = true;
        if (intent === this.intent && this.desiredRunning) this.acceptResult(result);
      }
      this.seeking = false;
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
    this.publishCompletion = false;
    ++this.intent;
    ++this.epoch;
    this.cancelStepTask();
    this.cancelEventTask();
    const video = invoke(() => this.actualPump().cancelAndJoin());
    try {
      if (this.timeline.state !== 'closed') this.timeline.pause();
    } catch (error) {
      this.recordFailure(error);
    }
    void (async () => {
      await this.join([video]);
      await this.transitions;
      await this.join([this.stepWork ?? Promise.resolve()]);
      this.drainEvents();
      this.detach();
      if (this.failure !== null) throw this.failure;
    })().then(resolve, reject);
    return completion;
  }
  private detach(): void {
    this.cancelStepTask();
    this.cancelEventTask();
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
      await this.join([invoke(() => this.cancelAndJoin())]);
      await this.join([invoke(() => this.actualPump().dispose())]);
      this.detach();
      this.events.dispose();
      this.timeline.dispose();
      this.eventObservers.clear();
      this.failureObservers.clear();
      if (this.failure !== null) throw this.failure;
    })().then(resolve, reject);
    return completion;
  }
}

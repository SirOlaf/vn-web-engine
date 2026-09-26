import {AokanaMovieAudioTransport} from './movie-audio-transport.js';
import {AokanaMovieVideoPump, type AokanaMovieVideoPumpResult} from './movie-video-pump.js';
import {AokanaMovieReceivePin} from './movie-receive.js';
import {AokanaMovieFilterEvents, type AokanaMovieFilterEvent} from './movie-filter-events.js';
import {AokanaMovieRenderer} from './movie-renderer.js';
import {AokanaTraditionalMovieRenderer} from './movie-traditional-renderer.js';
import {AokanaWindowMessages} from './window-messages.js';
import type {AokanaMovieVideoOutputLimits} from './movie-video-decoder.js';
import type {AokanaMoviePcmStatus} from './movie-pcm-protocol.js';
import type {AokanaIsoMovie, AokanaIsoTrack} from './movie-iso-samples.js';
import {aokanaIsoTime as time, type AokanaIsoRational} from './movie-iso-timeline.js';

export interface AokanaCombinedMovieEvent extends AokanaMovieFilterEvent {
  readonly generation: number;
}
function observe<T>(callback: (value: T) => void, value: T): void {
  try {
    callback(value);
  } catch {
    /* External observers do not own cleanup or results. */
  }
}
function invoke<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }
}

/** Selected decoded audio/video transport, not the HTML/native MediaGraph facade.
 * Owns audio only after successful create; renderer/image/device/messages stay borrowed.
 */
export class AokanaMovieCombinedTransport {
  private readonly events: AokanaMovieFilterEvents;
  private readonly pin: AokanaMovieReceivePin;
  private readonly audioToken = {};
  private pump: AokanaMovieVideoPump | null = null;
  private readonly creationAbort = new AbortController();
  private readonly removers: Array<() => void> = [];
  private readonly eventObservers = new Set<(event: AokanaCombinedMovieEvent) => void>();
  private readonly failureObservers = new Set<(error: unknown) => void>();
  private completion: AokanaCombinedMovieEvent | null = null;
  private generation: number;
  private epoch = 0;
  private intent = 0;
  private seeking = false;
  private desiredRunning = false;
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
  private readonly aborted = new DOMException('Combined movie canceled', 'AbortError');

  private constructor(
    private readonly audio: AokanaMovieAudioTransport,
    messages: AokanaWindowMessages,
    renderer: AokanaMovieRenderer | AokanaTraditionalMovieRenderer,
    generation: number,
  ) {
    this.generation = generation;
    this.events = new AokanaMovieFilterEvents(messages);
    this.pin = new AokanaMovieReceivePin(renderer, this.events, audio.clock);
    this.events.addRenderer(this.audioToken);
    this.removers.push(this.events.onAvailable(() => this.scheduleEvents()));
    this.removers.push(audio.onFailure((error) => this.fail(error)));
    this.removers.push(audio.onComplete((status) => this.observeAudioCompletion(status)));
  }
  static async create(
    audio: AokanaMovieAudioTransport,
    movie: AokanaIsoMovie,
    track: AokanaIsoTrack,
    messages: AokanaWindowMessages,
    renderer: AokanaMovieRenderer | AokanaTraditionalMovieRenderer,
    limits: AokanaMovieVideoOutputLimits,
    maxRgb32Bytes: number,
    signal?: AbortSignal,
  ): Promise<AokanaMovieCombinedTransport> {
    if (
      !(audio instanceof AokanaMovieAudioTransport) ||
      !audio.usesMovie(movie) ||
      !movie.tracks.includes(track) ||
      !(messages instanceof AokanaWindowMessages) ||
      (!(renderer instanceof AokanaMovieRenderer) &&
        !(renderer instanceof AokanaTraditionalMovieRenderer))
    )
      throw new Error('Combined movie requires actual shared movie and concrete renderer owners');
    const status = audio.acknowledgedStatus;
    if (status === null) throw new Error('Combined movie has no actual PCM acknowledgment');
    const seek = time.fraction(status.position.numerator, status.position.denominator);
    AokanaMovieCombinedTransport.requireFreshAudio(status, status.generation, seek);
    const owner = new AokanaMovieCombinedTransport(audio, messages, renderer, status.generation);
    const abort = (): void => {
      owner.terminal = true;
      owner.creationAbort.abort();
    };
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    try {
      owner.check();
      owner.pump = await AokanaMovieVideoPump.create(
        audio,
        owner.pin,
        movie,
        track,
        {...limits},
        maxRgb32Bytes,
        owner.creationAbort.signal,
      );
      owner.check();
      owner.removers.push(owner.pump.onFailure((error) => owner.fail(error)));
      owner.check();
      AokanaMovieCombinedTransport.requireFreshAudio(
        audio.acknowledgedStatus,
        status.generation,
        seek,
      );
      owner.owned = true;
      owner.publishCompletion = true;
      // Subscription precedes this actual-status recheck; no predicted EOS is used.
      const current = audio.acknowledgedStatus;
      if (current !== null) owner.observeAudioCompletion(current);
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
      throw first;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
  private static requireFreshAudio(
    status: AokanaMoviePcmStatus | null,
    generation: number,
    seek: AokanaIsoRational,
  ): void {
    if (
      status === null ||
      status.result !== 'ok' ||
      status.generation !== generation ||
      status.running ||
      status.ended ||
      status.stop !== null ||
      status.consumedFrames !== 0n ||
      status.retainedFrames !== 0 ||
      time.compare(status.position, seek) !== 0 ||
      time.compare(status.committedThrough, seek) !== 0
    )
      throw new Error('Combined movie creation requires the actual fresh paused audio epoch');
  }
  private observeAudioCompletion(status: AokanaMoviePcmStatus): void {
    if (
      !this.terminal &&
      this.publishCompletion &&
      status.result === 'ok' &&
      status.generation === this.generation &&
      status.ended
    )
      this.events.notify(this.audioToken, 1);
  }
  private check(): void {
    if (this.failure !== null) throw this.failure;
    if (this.terminal) throw this.aborted;
  }
  private actualPump(): AokanaMovieVideoPump {
    if (this.pump === null) throw new Error('Combined movie has no prepared video owner');
    return this.pump;
  }
  get currentTime(): bigint {
    return this.audio.clock.now();
  }
  get effectiveStop(): AokanaIsoRational {
    return this.audio.effectiveStop;
  }
  onEvent(observer: (event: AokanaCombinedMovieEvent) => void): () => void {
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
    if (error === this.aborted || this.failure !== null) return;
    this.failure = error;
    for (const observer of [...this.failureObservers]) observe(observer, error);
  }
  private fail(error: unknown): void {
    this.recordFailure(error);
    this.desiredRunning = false;
    this.cancelStepTask();
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
      const value: AokanaCombinedMovieEvent = {...event, generation: this.generation};
      if (event.code === 1) this.completion = value;
      if (event.code === 3)
        this.fail(
          new Error(`Movie renderer error 0x${BigInt.asUintN(32, event.value1).toString(16)}`),
        );
      for (const observer of [...this.eventObservers]) observe(observer, {...value});
    }
  }
  private acceptResult(result: AokanaMovieVideoPumpResult): void {
    if (result.mode !== 'audio' || result.audioGeneration !== this.generation)
      throw new Error('Combined movie received a foreign video epoch');
    if (result.kind === 'submitted-video-eos') this.videoEnded = true;
    if (result.kind === 'empty-video-eos' && !this.videoEnded) {
      this.videoEnded = true;
      // Selected profile: actual source EOS completes its real registered pin branch.
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
  private async joinBoth(work: readonly Promise<unknown>[]): Promise<void> {
    // Signal sibling cancellation as soon as one operation fails; the other may
    // be waiting on a decoder/Receive that only cancellation can wake.
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
      this.acceptResult(await this.actualPump().run());
      this.check();
      if (intent !== this.intent || !this.desiredRunning) return;
      await this.audio.run();
      this.check();
    });
  }
  pause(): Promise<void> {
    this.check();
    this.desiredRunning = false;
    ++this.intent;
    this.cancelStepTask();
    return this.transition(async () => {
      await this.joinBoth([
        invoke(() => this.actualPump().pause()),
        invoke(() => this.audio.pause()),
      ]);
      this.check();
      // Do not join clock-dependent Receive: native pause deliberately retains it.
    });
  }
  seek(position: AokanaIsoRational, resume = this.desiredRunning): Promise<void> {
    this.check();
    const seek = time.fraction(position.numerator, position.denominator);
    if (time.compare(seek, time.fraction(0n)) < 0 || time.compare(seek, this.effectiveStop) > 0)
      throw new RangeError('Combined movie seek exceeds its actual stop');
    if (this.seeking) throw new Error('Combined movie already has a pending seek');
    this.seeking = true;
    this.desiredRunning = resume;
    this.publishCompletion = false;
    const intent = ++this.intent;
    ++this.epoch;
    this.cancelStepTask();
    // Signal both before the outer queue: an earlier pause may be joining an audio read.
    const video = invoke(() => this.actualPump().beginSeek(seek));
    const audio = invoke(() => this.audio.seek(seek, false));
    void video.catch((error: unknown) => {
      if (!this.terminal) this.fail(error);
    });
    void audio.catch((error: unknown) => {
      if (!this.terminal) this.fail(error);
    });
    return this.transition(async () => {
      await this.joinBoth([video, audio]);
      await this.stepWork;
      this.check();
      this.cancelEventTask();
      this.drainEvents();
      this.check();
      this.events.resetCompletion();
      this.completion = null;
      const status = this.audio.acknowledgedStatus;
      if (status === null) throw new Error('Combined movie lost its seek acknowledgment');
      await this.actualPump().finishSeek(status.generation);
      this.check();
      this.generation = status.generation;
      this.videoEnded = false;
      this.publishCompletion = true;
      if (intent === this.intent && this.desiredRunning) {
        this.acceptResult(await this.actualPump().run());
        this.check();
        if (intent === this.intent && this.desiredRunning) {
          await this.audio.run();
          this.check();
        }
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
    const audio = invoke(() => this.audio.cancelAndJoin());
    void (async () => {
      await this.joinBoth([video, audio]);
      await this.transitions;
      await this.joinBoth([this.stepWork ?? Promise.resolve()]);
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
      await this.joinBoth([invoke(() => this.cancelAndJoin())]);
      await this.joinBoth([
        invoke(() => this.actualPump().dispose()),
        invoke(() => this.audio.dispose()),
      ]);
      this.detach();
      this.events.removeRenderer(this.audioToken);
      this.events.dispose();
      this.eventObservers.clear();
      this.failureObservers.clear();
      if (this.failure !== null) throw this.failure;
    })().then(resolve, reject);
    return completion;
  }
}

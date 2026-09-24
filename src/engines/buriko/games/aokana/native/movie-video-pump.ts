import {AokanaMovieAudioTransport} from './movie-audio-transport.js';
import {AokanaMovieReceivePin} from './movie-receive.js';
import {AokanaMovieVideoSamples, type AokanaMovieVideoSample} from './movie-video-samples.js';
import type {AokanaMovieVideoOutputLimits} from './movie-video-decoder.js';
import type {AokanaMovieMediaType} from './movie-image.js';
import type {AokanaIsoMovie, AokanaIsoTrack} from './movie-iso-samples.js';
import {
  aokanaIsoTime as time,
  aokanaIsoReferenceTime,
  type AokanaIsoRational,
} from './movie-iso-timeline.js';
import type {AokanaMoviePcmStatus} from './movie-pcm-protocol.js';

export interface AokanaMovieVideoPumpResult {
  readonly kind: 'running' | 'paused' | 'delivered' | 'submitted-video-eos' | 'empty-video-eos';
  readonly audioGeneration: number;
}
function sameType(left: AokanaMovieMediaType, right: AokanaMovieMediaType): boolean {
  return (
    left.majorType === right.majorType &&
    left.subtype === right.subtype &&
    left.formatType === right.formatType &&
    left.format.length === right.format.length &&
    left.format.every((value, index) => value === right.format[index])
  );
}
function notify(listener: (error: unknown) => void, error: unknown): void {
  try {
    listener(error);
  } catch {
    /* Observation cannot prevent mandatory cleanup. */
  }
}

/** Explicit ordered profile over actual decoded samples and native Receive ownership.
 * Owns its source and, only after successful create, its pin. Audio/renderer/events remain borrowed.
 */
export class AokanaMovieVideoPump {
  private source: AokanaMovieVideoSamples | null = null;
  private creation: Promise<AokanaMovieVideoSamples> | null = null;
  private prepared: AokanaMovieVideoSample | null = null;
  private sourceEnded = false;
  private eosSubmitted = false;
  private previousStart: bigint | null = null;
  private mediaType: AokanaMovieMediaType | null = null;
  private started = false;
  private desiredRunning = false;
  private phase: 'ready' | 'seeking' = 'ready';
  private epoch = 0;
  private intent = 0;
  private terminal = false;
  private ownedPin = false;
  private failure: unknown = null;
  private stepWork: Promise<AokanaMovieVideoPumpResult> | null = null;
  private transitions: Promise<void> = Promise.resolve();
  private transitionCount = 0;
  private cancellation: Promise<void> | null = null;
  private disposal: Promise<void> | null = null;
  private removeAudioFailure: (() => void) | null = null;
  private readonly observers = new Set<(error: unknown) => void>();
  private readonly aborted = new DOMException('Movie video pump canceled', 'AbortError');

  private constructor(
    private readonly audio: AokanaMovieAudioTransport,
    readonly pin: AokanaMovieReceivePin,
    private readonly movie: AokanaIsoMovie,
    private readonly track: AokanaIsoTrack,
    private readonly limits: AokanaMovieVideoOutputLimits,
    private readonly maxRgb32Bytes: number,
    private audioGeneration: number,
    private seekPosition: AokanaIsoRational,
  ) {}

  static async create(
    audio: AokanaMovieAudioTransport,
    pin: AokanaMovieReceivePin,
    movie: AokanaIsoMovie,
    track: AokanaIsoTrack,
    limits: AokanaMovieVideoOutputLimits,
    maxRgb32Bytes: number,
    signal?: AbortSignal,
  ): Promise<AokanaMovieVideoPump> {
    if (
      !(audio instanceof AokanaMovieAudioTransport) ||
      !(pin instanceof AokanaMovieReceivePin) ||
      pin.clock !== audio.clock
    )
      throw new Error('Movie video pump requires the actual shared audio clock and receive pin');
    if (
      pin.state !== 0 ||
      pin.connected ||
      pin.flushing ||
      pin.pendingSample !== null ||
      pin.runtimeError ||
      pin.aborted
    )
      throw new Error('Movie video pump requires an untouched stopped receive pin');
    const status = audio.acknowledgedStatus;
    if (status === null) throw new Error('Movie video pump has no actual audio acknowledgment');
    const seek = time.fraction(status.position.numerator, status.position.denominator),
      pump = new AokanaMovieVideoPump(
        audio,
        pin,
        movie,
        track,
        {...limits},
        maxRgb32Bytes,
        status.generation,
        seek,
      );
    pump.validateAudio(true);
    const abort = (): void => {
      pump.terminal = true;
      pump.disposeSource();
    };
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    pump.removeAudioFailure = audio.onFailure((error) => pump.fail(error));
    try {
      pump.check();
      await pump.prepareSource();
      pump.check();
      pump.validateAudio(true);
      // No pin mutation occurs before this successful ownership transfer.
      pump.ownedPin = true;
      return pump;
    } catch (error) {
      const first = pump.failure ?? error;
      pump.disposeSource();
      pump.releasePrepared();
      pump.removeAudioFailure?.();
      throw first;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  private check(): void {
    if (this.failure !== null) throw this.failure;
    if (this.terminal) throw this.aborted;
  }
  private checkEpoch(epoch: number): void {
    this.check();
    if (epoch !== this.epoch) throw this.aborted;
  }
  private recordFailure(error: unknown): void {
    if (error === this.aborted || this.failure !== null) return;
    this.failure = error;
    for (const observer of [...this.observers]) notify(observer, error);
  }
  private fail(error: unknown): void {
    this.recordFailure(error);
    this.desiredRunning = false;
    if (this.ownedPin) void this.cancelAndJoin().catch(() => {});
    else this.disposeSource();
  }
  private disposeSource(): void {
    const source = this.source;
    this.source = null;
    try {
      source?.dispose();
    } catch (error) {
      this.recordFailure(error);
    }
  }
  private releasePrepared(): void {
    const sample = this.prepared;
    this.prepared = null;
    this.releaseSample(sample);
  }
  private releaseSample(sample: AokanaMovieVideoSample | null): void {
    try {
      sample?.release();
    } catch (error) {
      this.recordFailure(error);
    }
  }
  onFailure(observer: (error: unknown) => void): () => void {
    this.observers.add(observer);
    if (this.failure !== null) notify(observer, this.failure);
    return () => {
      this.observers.delete(observer);
    };
  }
  private validateAudio(fresh: boolean, generation = this.audioGeneration): AokanaMoviePcmStatus {
    const status = this.audio.acknowledgedStatus;
    if (
      this.pin.clock !== this.audio.clock ||
      status === null ||
      status.result !== 'ok' ||
      status.generation !== generation
    )
      throw new Error('Movie video pump received a foreign audio clock/generation');
    if (
      fresh &&
      (status.running ||
        status.ended ||
        status.stop !== null ||
        status.consumedFrames !== 0n ||
        status.retainedFrames !== 0 ||
        time.compare(status.position, this.seekPosition) !== 0 ||
        time.compare(status.committedThrough, this.seekPosition) !== 0)
    )
      throw new Error('Movie video preparation requires the actual fresh paused audio seek');
    return status;
  }
  private startFlush(): Promise<number> {
    try {
      return Promise.resolve(this.pin.beginFlush());
    } catch (error) {
      return Promise.reject(error);
    }
  }
  private hresult(status: number): void {
    if ((status | 0) < 0)
      throw new Error(`Movie receive operation failed: 0x${(status >>> 0).toString(16)}`);
  }
  private result(kind: AokanaMovieVideoPumpResult['kind']): AokanaMovieVideoPumpResult {
    return {kind, audioGeneration: this.audioGeneration};
  }
  private async prepareSource(): Promise<void> {
    this.check();
    const epoch = this.epoch;
    const work = AokanaMovieVideoSamples.create(this.movie, this.track, {
      outputLimits: this.limits,
      maxRgb32Bytes: this.maxRgb32Bytes,
      timestampMode: 'absolute',
    });
    this.creation = work;
    let source: AokanaMovieVideoSamples;
    try {
      source = await work;
      this.source = source;
    } finally {
      if (this.creation === work) this.creation = null;
    }
    try {
      this.checkEpoch(epoch);
      if (time.compare(source.timeline.exactDuration, this.audio.effectiveStop) > 0)
        throw new Error('Movie video duration exceeds the actual audio common stop');
      source.seek(aokanaIsoReferenceTime(this.seekPosition));
      const sample = await source.next();
      try {
        this.checkEpoch(epoch);
      } catch (error) {
        this.recordFailure(error);
        this.releaseSample(sample);
        throw this.failure ?? error;
      }
      this.prepared = sample;
      this.sourceEnded = sample === null;
    } catch (error) {
      const retiredAbort =
        (this.terminal || epoch !== this.epoch) &&
        error instanceof DOMException &&
        error.name === 'AbortError';
      if (!retiredAbort) this.recordFailure(error);
      if (this.source === source) this.disposeSource();
      throw retiredAbort ? this.aborted : error;
    }
  }
  private connectPrepared(): void {
    if (!this.pin.connected && this.prepared !== null) {
      this.hresult(this.pin.connect(this.prepared.type));
      this.mediaType = this.prepared.type;
    }
    this.pin.sourceStopPosition = aokanaIsoReferenceTime(this.audio.effectiveStop);
  }
  private transition<T>(operation: () => Promise<T>): Promise<T> {
    this.transitionCount++;
    const work = this.transitions.then(async () => {
      this.check();
      return operation();
    });
    const finished = work.finally(() => {
      this.transitionCount--;
    });
    this.transitions = finished.then(
      () => {},
      (error: unknown) => {
        if (!this.terminal) this.fail(error);
        else this.recordFailure(error);
      },
    );
    return finished;
  }
  run(): Promise<AokanaMovieVideoPumpResult> {
    this.check();
    this.desiredRunning = true;
    const intent = ++this.intent;
    return this.transition(async () => {
      if (intent !== this.intent) return this.result('paused');
      if (this.phase !== 'ready') throw new Error('Movie video seek is not acknowledged');
      this.validateAudio(!this.started);
      this.connectPrepared();
      this.check();
      if (this.pin.connected) this.hresult(await this.pin.run(0n));
      this.check();
      this.started = true;
      return this.result(!this.pin.connected && this.sourceEnded ? 'empty-video-eos' : 'running');
    });
  }
  pause(): Promise<void> {
    this.check();
    this.desiredRunning = false;
    ++this.intent;
    return this.transition(async () => {
      this.hresult(await this.pin.pause());
      this.check();
      // A native pending Receive intentionally stays owned until run or flush.
    });
  }
  step(): Promise<AokanaMovieVideoPumpResult> {
    this.check();
    if (this.stepWork !== null || this.transitionCount !== 0)
      throw new Error('Concurrent movie video pump work');
    if (!this.desiredRunning || !this.started || this.phase !== 'ready')
      return Promise.resolve(this.result('paused'));
    const epoch = this.epoch;
    const work = this.performStep(epoch).catch((error: unknown) => {
      if (
        (this.terminal || epoch !== this.epoch) &&
        error instanceof DOMException &&
        error.name === 'AbortError'
      )
        throw this.aborted;
      this.fail(error);
      throw error;
    });
    this.stepWork = work;
    return work.finally(() => {
      if (this.stepWork === work) this.stepWork = null;
    });
  }
  private async performStep(epoch: number): Promise<AokanaMovieVideoPumpResult> {
    this.validateAudio(false);
    if (this.prepared === null && !this.sourceEnded) {
      const source = this.source;
      if (source === null) throw new Error('Movie video pump has no live source');
      const sample = await source.next();
      try {
        this.checkEpoch(epoch);
      } catch (error) {
        this.recordFailure(error);
        this.releaseSample(sample);
        throw this.failure ?? error;
      }
      this.prepared = sample;
      this.sourceEnded = sample === null;
    }
    this.checkEpoch(epoch);
    if (!this.desiredRunning) return this.result('paused');
    if (this.prepared === null) {
      if (!this.pin.connected) return this.result('empty-video-eos');
      if (!this.eosSubmitted) {
        this.hresult(await this.pin.endOfStream());
        this.checkEpoch(epoch);
        this.eosSubmitted = true;
      }
      return this.result('submitted-video-eos');
    }
    const sample = this.prepared;
    this.prepared = null;
    try {
      const sampleTime = sample.sample.time;
      if (
        sampleTime === null ||
        (this.previousStart !== null && sampleTime.start < this.previousStart)
      )
        throw new Error('Movie video violates the selected nondecreasing mapped-start profile');
      this.previousStart = sampleTime.start;
      const changed = this.mediaType === null || !sameType(this.mediaType, sample.type);
      this.hresult(
        await this.pin.receive(
          changed ? {...sample.sample, mediaType: sample.type} : sample.sample,
        ),
      );
      this.checkEpoch(epoch);
      this.mediaType = sample.type;
      return this.result('delivered');
    } catch (error) {
      this.recordFailure(error);
      throw error;
    } finally {
      this.releaseSample(sample);
      if (this.failure !== null) throw this.failure;
    }
  }

  beginSeek(position: AokanaIsoRational): Promise<void> {
    this.check();
    const seek = time.fraction(position.numerator, position.denominator);
    if (
      time.compare(seek, time.fraction(0n)) < 0 ||
      time.compare(seek, this.audio.effectiveStop) > 0
    )
      throw new RangeError('Movie video seek exceeds actual common stop');
    if (this.phase === 'seeking') throw new Error('Movie video already has a pending seek');
    this.phase = 'seeking';
    this.desiredRunning = false;
    ++this.intent;
    ++this.epoch;
    // Signal before joining clock-dependent Receive, outside any blocked queue.
    const flush = this.startFlush();
    void flush.catch(() => {});
    this.disposeSource();
    return this.transition(async () => {
      this.hresult(await flush);
      try {
        await this.stepWork;
      } catch (error) {
        if (error !== this.aborted) throw error;
      }
      this.check();
      this.hresult(await this.pin.pause());
      this.releasePrepared();
      this.check();
      this.seekPosition = seek;
      this.previousStart = null;
      this.started = this.eosSubmitted = this.sourceEnded = false;
      await this.prepareSource();
      this.check();
      // Remain paused AND flushing until finishSeek sees the real audio acknowledgment.
    });
  }
  finishSeek(expectedAudioGeneration: number): Promise<void> {
    this.check();
    return this.transition(async () => {
      if (this.phase !== 'seeking') throw new Error('Movie video has no pending seek');
      if (expectedAudioGeneration <= this.audioGeneration)
        throw new Error('Movie video seek requires a new acknowledged audio generation');
      this.validateAudio(true, expectedAudioGeneration);
      this.audioGeneration = expectedAudioGeneration;
      this.connectPrepared();
      this.check();
      this.hresult(await this.pin.endFlush());
      this.check();
      this.validateAudio(true);
      this.phase = 'ready';
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
    ++this.epoch;
    const flush = this.startFlush();
    void flush.catch(() => {});
    this.disposeSource();
    void (async () => {
      try {
        this.hresult(await flush);
      } catch (error) {
        this.recordFailure(error);
      }
      await this.transitions;
      try {
        await this.creation;
      } catch (error) {
        this.recordFailure(error);
      }
      this.disposeSource();
      try {
        await this.stepWork;
      } catch (error) {
        if (error !== this.aborted) this.recordFailure(error);
      }
      this.releasePrepared();
      try {
        this.hresult(await this.pin.stop());
      } catch (error) {
        this.recordFailure(error);
      }
      this.removeAudioFailure?.();
      this.removeAudioFailure = null;
      if (this.failure !== null) throw this.failure;
    })().then(resolve, reject);
    return completion;
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
        if (this.ownedPin) this.pin.dispose();
      } catch (error) {
        this.recordFailure(error);
      } finally {
        this.source = null;
        this.observers.clear();
      }
      if (this.failure !== null) throw this.failure;
    })().then(resolve, reject);
    return completion;
  }
}

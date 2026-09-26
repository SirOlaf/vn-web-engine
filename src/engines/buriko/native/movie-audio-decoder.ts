import {burikoIsoAacConfiguration, type BurikoAacDecoderConfiguration} from './movie-iso-codecs.js';
import {
  burikoIsoSampleBytes,
  BurikoIsoSampleError,
  type BurikoIsoMovie,
  type BurikoIsoTrack,
} from './movie-iso-samples.js';
import type {BurikoIsoRational} from './movie-iso-timeline.js';

// TypeScript's DOM library does not expose the standard AudioDecoder surface on every release.
interface BrowserAudioData {
  readonly timestamp: number;
  readonly numberOfChannels: number;
  readonly numberOfFrames: number;
  readonly sampleRate: number;
  copyTo(destination: Float32Array, options: {planeIndex: number; format: 'f32-planar'}): void;
  close(): void;
}
interface BrowserAudioDecoder {
  readonly state: 'unconfigured' | 'configured' | 'closed';
  readonly decodeQueueSize: number;
  ondequeue: (() => void) | null;
  configure(config: BurikoAacDecoderConfiguration): void;
  decode(chunk: object): void;
  flush(): Promise<void>;
  close(): void;
}
interface BrowserAudioDecoderConstructor {
  new (init: {
    output(data: BrowserAudioData): void;
    error(error: DOMException): void;
  }): BrowserAudioDecoder;
  isConfigSupported(config: BurikoAacDecoderConfiguration): Promise<{supported: boolean}>;
}
interface BrowserAudioChunkConstructor {
  new (init: {
    type: 'key' | 'delta';
    timestamp: number;
    duration: number;
    data: Uint8Array;
  }): object;
}
interface AudioCodecWindow {
  AudioDecoder?: BrowserAudioDecoderConstructor;
  EncodedAudioChunk?: BrowserAudioChunkConstructor;
}

export interface BurikoDecodedMovieAudio {
  readonly planes: readonly Float32Array[];
  readonly sampleRate: number;
  readonly frameCount: number;
  /** Exact source seconds when the codec's timestamp identifies an original input time. */
  readonly mediaStart: BurikoIsoRational;
}

/** Optional bounds on copied JavaScript PCM, not browser decoder-internal memory. */
export interface BurikoMovieAudioOutputLimits {
  readonly channels: 1 | 2;
  readonly maxChunkFrames: number;
  readonly maxQueuedFrames: number;
}

interface AudioOrigin {
  readonly microseconds: number;
  readonly ticks: bigint;
}

/**
 * AAC receives real timestamps: unlike AVC, platform audio decoders derive later
 * timestamps from their PCM frame counts. A timestamp exactly matching one unique
 * source origin restores that origin's fractional media tick. Other outputs keep
 * the actual standard API timestamp, without inventing an access-unit identity.
 */
export class BurikoMovieAudioDecoder {
  private decoder: BrowserAudioDecoder;
  private readonly output: BurikoDecodedMovieAudio[] = [];
  private readonly waiters = new Set<() => void>();
  private readonly origins = new Map<number, AudioOrigin | null>();
  private generation = 0;
  private reading: number | null = null;
  private index = 0;
  private description = -1;
  private flushed = false;
  private disposed = false;
  private failure: unknown = null;
  private queuedFrames = 0;

  private constructor(
    readonly movie: BurikoIsoMovie,
    readonly track: BurikoIsoTrack,
    private readonly Decoder: BrowserAudioDecoderConstructor,
    private readonly Chunk: BrowserAudioChunkConstructor,
    private readonly configurations: ReadonlyMap<number, BurikoAacDecoderConfiguration>,
    private readonly limits: BurikoMovieAudioOutputLimits | undefined,
  ) {
    for (const sample of track.samples) {
      const microseconds = Number((sample.compositionTime * 1000000n) / BigInt(track.timescale));
      if (!Number.isSafeInteger(microseconds))
        throw new BurikoIsoSampleError('AAC sample time exceeds the browser integer range');
      const prior = this.origins.get(microseconds);
      if (prior === undefined)
        this.origins.set(microseconds, {microseconds, ticks: sample.compositionTime});
      else if (prior !== null && prior.ticks !== sample.compositionTime)
        this.origins.set(microseconds, null);
    }
    this.decoder = this.createDecoder();
  }
  static async create(
    movie: BurikoIsoMovie,
    track: BurikoIsoTrack,
    limits?: BurikoMovieAudioOutputLimits,
  ): Promise<BurikoMovieAudioDecoder> {
    const copiedLimits = limits === undefined ? undefined : {...limits};
    if (
      copiedLimits !== undefined &&
      ((copiedLimits.channels !== 1 && copiedLimits.channels !== 2) ||
        !Number.isSafeInteger(copiedLimits.maxChunkFrames) ||
        copiedLimits.maxChunkFrames < 1 ||
        !Number.isSafeInteger(copiedLimits.maxQueuedFrames) ||
        copiedLimits.maxQueuedFrames < copiedLimits.maxChunkFrames ||
        !Number.isSafeInteger(copiedLimits.maxQueuedFrames * copiedLimits.channels * 4))
    )
      throw new BurikoIsoSampleError('Invalid copied AAC output admission limits');
    const {AudioDecoder: Decoder, EncodedAudioChunk: Chunk} = globalThis as AudioCodecWindow;
    if (Decoder === undefined || Chunk === undefined)
      throw new DOMException('This browser has no WebCodecs audio decoder', 'NotSupportedError');
    const configurations = new Map<number, BurikoAacDecoderConfiguration>();
    for (const sample of track.samples) {
      if (configurations.has(sample.description)) continue;
      const description = track.descriptions[sample.description - 1];
      if (description === undefined)
        throw new BurikoIsoSampleError('AAC sample has no description');
      const config = burikoIsoAacConfiguration(description),
        support = await Decoder.isConfigSupported(config);
      if (!support.supported)
        throw new DOMException(`This browser cannot decode ${config.codec}`, 'NotSupportedError');
      configurations.set(sample.description, config);
    }
    return new BurikoMovieAudioDecoder(movie, track, Decoder, Chunk, configurations, copiedLimits);
  }
  private createDecoder(): BrowserAudioDecoder {
    const generation = this.generation;
    const decoder = new this.Decoder({
      output: (data) => {
        try {
          if (this.disposed || generation !== this.generation || this.failure !== null) return;
          if (!Number.isSafeInteger(data.timestamp))
            throw new BurikoIsoSampleError(
              'AAC output timestamp exceeds the browser integer range',
            );
          if (
            this.limits !== undefined &&
            (data.numberOfChannels !== this.limits.channels ||
              !Number.isSafeInteger(data.numberOfFrames) ||
              data.numberOfFrames < 1 ||
              data.numberOfFrames > this.limits.maxChunkFrames ||
              data.numberOfFrames > this.limits.maxQueuedFrames - this.queuedFrames ||
              !Number.isSafeInteger(data.sampleRate) ||
              data.sampleRate < 1)
          )
            throw new BurikoIsoSampleError('Actual AAC output exceeds its negotiated PCM profile');
          const planes = Array.from({length: data.numberOfChannels}, (_, planeIndex) => {
            const plane = new Float32Array(data.numberOfFrames);
            data.copyTo(plane, {planeIndex, format: 'f32-planar'});
            return plane;
          });
          const origin = this.origins.get(data.timestamp);
          const mediaStart =
            origin == null
              ? {numerator: BigInt(data.timestamp), denominator: 1000000n}
              : {numerator: origin.ticks, denominator: BigInt(this.track.timescale)};
          this.output.push({
            planes,
            mediaStart,
            frameCount: data.numberOfFrames,
            sampleRate: data.sampleRate,
          });
          this.queuedFrames += data.numberOfFrames;
        } catch (error) {
          this.failure ??= error;
        } finally {
          data.close();
          this.wake();
        }
      },
      error: (error) => {
        if (this.disposed || generation !== this.generation) return;
        this.failure ??= error;
        this.wake();
      },
    });
    decoder.ondequeue = () => this.wake();
    return decoder;
  }
  private wake(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const resolve of waiters) resolve();
  }
  private check(generation: number): void {
    if (this.disposed || generation !== this.generation)
      throw new DOMException('Movie audio decode was cancelled', 'AbortError');
    if (this.failure !== null) throw this.failure;
  }
  async next(): Promise<BurikoDecodedMovieAudio | null> {
    const generation = this.generation;
    this.check(generation);
    if (this.reading === generation) throw new Error('Concurrent Buriko AAC reads');
    this.reading = generation;
    try {
      for (;;) {
        this.check(generation);
        const output = this.output.shift();
        if (output !== undefined) {
          this.queuedFrames -= output.frameCount;
          return output;
        }
        if (this.flushed) return null;
        const sample = this.track.samples[this.index];
        if (sample === undefined) {
          if (this.description !== -1) await this.decoder.flush();
          this.check(generation);
          this.flushed = true;
          continue;
        }
        if (sample.description !== this.description) {
          if (this.description !== -1) {
            await this.decoder.flush();
            this.check(generation);
            this.description = -1;
            if (this.output.length !== 0) continue;
          }
          const config = this.configurations.get(sample.description);
          if (config === undefined)
            throw new BurikoIsoSampleError('AAC description was not negotiated');
          this.decoder.configure(config);
          this.description = sample.description;
        }
        if (this.decoder.decodeQueueSize !== 0) {
          await new Promise<void>((resolve) => this.waiters.add(resolve));
          continue;
        }
        const timestamp = Number(
            (sample.compositionTime * 1000000n) / BigInt(this.track.timescale),
          ),
          duration = Number((BigInt(sample.duration) * 1000000n) / BigInt(this.track.timescale));
        if (!Number.isSafeInteger(timestamp) || !Number.isSafeInteger(duration))
          throw new BurikoIsoSampleError('AAC sample time exceeds the browser integer range');
        const chunk = new this.Chunk({
          // AAC's WebCodecs registration requires key even when ISO stss differs.
          type: 'key',
          timestamp,
          duration,
          data: burikoIsoSampleBytes(this.movie, this.track, sample),
        });
        this.index++;
        this.decoder.decode(chunk);
      }
    } finally {
      if (this.reading === generation) this.reading = null;
    }
  }
  /** Decode from the beginning after seeking so AAC overlap/codec delay is real preroll. */
  reset(): void {
    if (this.disposed) throw new DOMException('Movie audio decoder is closed', 'InvalidStateError');
    this.generation++;
    if (this.decoder.state !== 'closed') this.decoder.close();
    this.output.length = 0;
    this.queuedFrames = 0;
    this.index = 0;
    this.description = -1;
    this.flushed = false;
    this.failure = null;
    this.decoder = this.createDecoder();
    this.wake();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    if (this.decoder.state !== 'closed') this.decoder.close();
    this.output.length = 0;
    this.queuedFrames = 0;
    this.origins.clear();
    this.wake();
  }
}

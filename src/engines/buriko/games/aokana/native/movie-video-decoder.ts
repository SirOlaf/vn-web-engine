import {aokanaIsoAvcConfiguration} from './movie-iso-codecs.js';
import {
  aokanaIsoSampleBytes,
  AokanaIsoSampleError,
  type AokanaIsoMovie,
  type AokanaIsoTrack,
} from './movie-iso-samples.js';
import {aokanaIsoDecodeStart} from './movie-iso-timeline.js';

/** Explicit retained-output profile; not a bound on opaque browser decoder allocations. */
export interface AokanaMovieVideoOutputLimits {
  readonly maxQueuedPictures: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly maxPixels: number;
}

function copyOutputLimits(
  limits: AokanaMovieVideoOutputLimits | undefined,
): AokanaMovieVideoOutputLimits | undefined {
  if (limits === undefined) return undefined;
  const copied = {...limits};
  if (
    [copied.maxQueuedPictures, copied.maxWidth, copied.maxHeight, copied.maxPixels].some(
      (value) => !Number.isSafeInteger(value) || value < 1,
    ) ||
    copied.maxWidth > 0x7fffffff ||
    copied.maxHeight > 0x7fffffff
  )
    throw new RangeError('Invalid movie video output admission limits');
  return copied;
}

function admitGeometry(frame: VideoFrame, limits: AokanaMovieVideoOutputLimits): void {
  const rectangle = frame.visibleRect;
  if (rectangle === null) throw new AokanaIsoSampleError('AVC output has no visible rectangle');
  for (const [width, height] of [
    [frame.codedWidth, frame.codedHeight],
    [frame.displayWidth, frame.displayHeight],
    [rectangle.width, rectangle.height],
  ] as const) {
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > limits.maxWidth ||
      height > limits.maxHeight ||
      !Number.isSafeInteger(width * height) ||
      width * height > limits.maxPixels
    )
      throw new AokanaIsoSampleError('AVC output exceeds its declared geometry profile');
  }
  if (
    !Number.isSafeInteger(rectangle.x) ||
    !Number.isSafeInteger(rectangle.y) ||
    rectangle.x < 0 ||
    rectangle.y < 0 ||
    !Number.isSafeInteger(rectangle.x + rectangle.width) ||
    !Number.isSafeInteger(rectangle.y + rectangle.height) ||
    rectangle.x + rectangle.width > frame.codedWidth ||
    rectangle.y + rectangle.height > frame.codedHeight
  )
    throw new AokanaIsoSampleError('AVC visible rectangle exceeds its coded geometry');
}

export interface AokanaDecodedMoviePicture {
  readonly sampleIndex: number;
  /** Ownership transfers to the reader, which must close this actual codec output. */
  readonly frame: VideoFrame;
}

const cancelled = (): DOMException =>
  new DOMException('Movie decoding was cancelled', 'AbortError');

/**
 * The installed AVC filter uses WebCodecs only for compressed-picture decoding.
 * Unique integer transport timestamps identify access units; ISO presentation
 * times remain exact in the splitter and never come from a presented-frame event.
 */
export class AokanaMovieVideoDecoder {
  private decoder: VideoDecoder;
  private readonly pictures: AokanaDecodedMoviePicture[] = [];
  private readonly waiters = new Set<() => void>();
  private failure: unknown = null;
  private generation = 0;
  private disposed = false;
  private index = 0;
  private endIndex: number;
  private configuredDescription = -1;
  private flushed = false;
  private readingGeneration: number | null = null;

  private constructor(
    readonly movie: AokanaIsoMovie,
    readonly track: AokanaIsoTrack,
    private readonly configurations: ReadonlyMap<number, VideoDecoderConfig>,
    private readonly limits: AokanaMovieVideoOutputLimits | undefined,
  ) {
    this.endIndex = track.samples.length;
    this.decoder = this.createDecoder();
  }

  static async create(
    movie: AokanaIsoMovie,
    track: AokanaIsoTrack,
    limits?: AokanaMovieVideoOutputLimits,
  ): Promise<AokanaMovieVideoDecoder> {
    const copiedLimits = copyOutputLimits(limits);
    if (typeof VideoDecoder === 'undefined' || typeof EncodedVideoChunk === 'undefined')
      throw new DOMException('This browser has no WebCodecs video decoder', 'NotSupportedError');
    const configurations = new Map<number, VideoDecoderConfig>();
    for (const sample of track.samples) {
      if (configurations.has(sample.description)) continue;
      const description = track.descriptions[sample.description - 1];
      if (description === undefined)
        throw new AokanaIsoSampleError('AVC sample has no description');
      const config = aokanaIsoAvcConfiguration(description);
      const support = await VideoDecoder.isConfigSupported(config);
      if (!support.supported)
        throw new DOMException(`This browser cannot decode ${config.codec}`, 'NotSupportedError');
      configurations.set(sample.description, config);
    }
    return new AokanaMovieVideoDecoder(movie, track, configurations, copiedLimits);
  }

  private createDecoder(): VideoDecoder {
    const generation = this.generation;
    const decoder = new VideoDecoder({
      output: (frame) => {
        let published = false;
        try {
          if (generation !== this.generation || this.disposed || this.failure !== null) return;
          const sampleIndex = frame.timestamp;
          if (
            !Number.isSafeInteger(sampleIndex) ||
            sampleIndex < 0 ||
            sampleIndex >= this.track.samples.length
          )
            throw new AokanaIsoSampleError('AVC decoder returned an unknown access-unit timestamp');
          if (this.limits !== undefined) {
            if (this.pictures.length >= this.limits.maxQueuedPictures)
              throw new AokanaIsoSampleError(
                'AVC output exceeds its declared queued-picture budget',
              );
            admitGeometry(frame, this.limits);
          }
          this.pictures.push({sampleIndex, frame});
          published = true;
        } catch (error) {
          this.failure ??= error;
        } finally {
          if (!published) frame.close();
          this.wake();
        }
      },
      error: (error) => {
        if (generation !== this.generation || this.disposed) return;
        this.failure ??= error;
        this.wake();
      },
    });
    decoder.ondequeue = () => this.wake();
    return decoder;
  }
  private wake(): void {
    const waiting = [...this.waiters];
    this.waiters.clear();
    for (const resolve of waiting) resolve();
  }
  private check(generation: number): void {
    if (this.disposed || generation !== this.generation) throw cancelled();
    if (this.failure !== null) throw this.failure;
  }
  private wait(): Promise<void> {
    return new Promise((resolve) => this.waiters.add(resolve));
  }

  /** Only real outputs are returned: a non-picture access unit does not invent a sample. */
  async next(): Promise<AokanaDecodedMoviePicture | null> {
    const generation = this.generation;
    this.check(generation);
    if (this.readingGeneration === generation) throw new Error('Concurrent Aokana AVC reads');
    this.readingGeneration = generation;
    try {
      for (;;) {
        this.check(generation);
        const picture = this.pictures.shift();
        if (picture !== undefined) return picture;
        if (this.flushed) return null;
        const sample = this.index < this.endIndex ? this.track.samples[this.index] : undefined;
        if (sample === undefined) {
          if (this.configuredDescription !== -1) await this.decoder.flush();
          this.check(generation);
          this.flushed = true;
          continue;
        }
        if (sample.description !== this.configuredDescription) {
          if (this.configuredDescription !== -1) {
            await this.decoder.flush();
            this.check(generation);
            this.configuredDescription = -1;
            if (this.pictures.length !== 0) continue;
          }
          const config = this.configurations.get(sample.description);
          if (config === undefined)
            throw new AokanaIsoSampleError('AVC description was not negotiated');
          this.decoder.configure(config);
          this.configuredDescription = sample.description;
        }
        if (this.decoder.decodeQueueSize !== 0) {
          await this.wait();
          continue;
        }
        const duration = Number(
          (BigInt(sample.duration) * 1000000n) / BigInt(this.track.timescale),
        );
        if (!Number.isSafeInteger(duration))
          throw new AokanaIsoSampleError('AVC duration exceeds the browser time range');
        const chunk = new EncodedVideoChunk({
          type: sample.sync ? 'key' : 'delta',
          timestamp: this.index,
          duration,
          data: aokanaIsoSampleBytes(this.movie, this.track, sample),
        });
        this.index++;
        this.decoder.decode(chunk);
      }
    } finally {
      if (this.readingGeneration === generation) this.readingGeneration = null;
    }
  }

  /** Reset discards codec-owned work; already returned pictures remain reader-owned. */
  seek(sampleIndex: number, endIndex = this.track.samples.length): number {
    if (this.disposed) throw cancelled();
    const index = aokanaIsoDecodeStart(this.track, sampleIndex);
    if (
      !Number.isInteger(endIndex) ||
      endIndex <= sampleIndex ||
      endIndex > this.track.samples.length
    )
      throw new AokanaIsoSampleError('AVC edit decode extent is outside its sample table');
    this.generation++;
    if (this.decoder.state !== 'closed') this.decoder.close();
    for (const picture of this.pictures) picture.frame.close();
    this.pictures.length = 0;
    this.failure = null;
    this.index = index;
    this.endIndex = endIndex;
    this.configuredDescription = -1;
    this.flushed = false;
    this.decoder = this.createDecoder();
    this.wake();
    return index;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    if (this.decoder.state !== 'closed') this.decoder.close();
    for (const picture of this.pictures) picture.frame.close();
    this.pictures.length = 0;
    this.wake();
  }
}

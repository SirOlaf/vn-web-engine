import type {AokanaLockActors} from '../exclusion-locks.js';
import type {AokanaLiveAudioStorage} from './live-storage.js';
import {
  createAokanaCustomWaveBoxDecoder,
  createAokanaLiveCustomWaveBoxDecoder,
  type AokanaLiveWaveBoxDecoder,
  type AokanaWaveBoxDecoder,
} from './wavebox-codecs.js';
import {parseAokanaWaveBoxHeader} from './wavebox-header.js';
import {createAokanaWaveBoxOggDecoder, type AokanaWaveBoxOggDecoder} from './wavebox-ogg.js';
import type {AokanaOggExchangeDecoder} from './ogg-exchange-stream.js';

export type AokanaWaveDecoder =
  AokanaWaveBoxDecoder | AokanaWaveBoxOggDecoder | AokanaLiveWaveBoxDecoder | AokanaOggExchangeDecoder;

/** CRotateBuffer/CRotateBufferSecurity: independently wrapping read/write positions and byte fill count. */
export class AokanaWaveFifo {
  readonly storage: Uint8Array;
  private readPosition = 0;
  private writePosition = 0;
  private filled = 0;
  constructor(readonly capacity: number) {
    this.storage = new Uint8Array(capacity >>> 0);
  }
  get available(): number {
    return this.filled;
  }
  get free(): number {
    return (this.capacity - this.filled) >>> 0;
  }
  clear(): void {
    this.readPosition = this.writePosition = this.filled = 0;
  }
  write(bytes: Uint8Array): number {
    const count = Math.min(this.free, bytes.length);
    if (count === 0) return 0;
    const first = Math.min(count, this.capacity - this.writePosition);
    this.storage.set(bytes.subarray(0, first), this.writePosition);
    this.storage.set(bytes.subarray(first, count), 0);
    this.writePosition = (this.writePosition + count) % this.capacity;
    this.filled += count;
    return count;
  }
  readInto(
    destination: Uint8Array,
    offset: number,
    length: number,
    initialized?: Uint8Array,
  ): number {
    const count = Math.min(this.filled, length >>> 0);
    if (offset < 0 || offset + count > destination.length)
      throw new RangeError('Aokana audio read crosses native destination allocation');
    if (count === 0) return 0;
    if (initialized !== undefined && offset + count > initialized.length)
      throw new RangeError('Aokana FIFO read exceeds destination initialization storage');
    const first = Math.min(count, this.capacity - this.readPosition);
    destination.set(this.storage.subarray(this.readPosition, this.readPosition + first), offset);
    initialized?.fill(1, offset, offset + first);
    destination.set(this.storage.subarray(0, count - first), offset + first);
    initialized?.fill(1, offset + first, offset + count);
    this.readPosition = (this.readPosition + count) % this.capacity;
    this.filled -= count;
    return count;
  }
}

/** CWaveStreamCtrl + CBurikoWaveBoxModel's separate consumer state; no speaker or browser playback policy. */
export class AokanaWaveStream {
  readonly fifo: AokanaWaveFifo;
  readonly bytesPerFrame: number;
  private consumerPosition = 0;
  private loopCount = 0;
  private loopDeadline = 0;
  private producerEnded = false;
  private disposed = false;
  private stopping = false;
  private disposal: Promise<void> | null = null;
  private readonly producerActor = {};
  private worker: ReturnType<typeof setTimeout> | null = null;
  private locked: Promise<void> | null = null;
  private workerFailure: unknown = null;
  constructor(
    readonly decoder: AokanaWaveDecoder,
    readonly rawMilliseconds: () => number,
    private readonly actors?: AokanaLockActors,
  ) {
    this.bytesPerFrame = Math.imul(decoder.channels, decoder.outputBits >>> 3) >>> 0;
    this.fifo = new AokanaWaveFifo(
      Math.imul(Math.imul(4, decoder.sampleRate), this.bytesPerFrame) >>> 0,
    );
  }
  get framePosition(): number {
    return this.consumerPosition;
  }
  get sourceFrameCount(): number {
    return this.decoder.sourceFrameCount;
  }
  get loopEnabled(): number {
    return this.decoder.loopEnabled;
  }
  get sampleRate(): number {
    return this.decoder.sampleRate;
  }
  get channels(): number {
    return this.decoder.channels;
  }
  get outputBits(): 16 | 24 {
    return this.decoder.outputBits;
  }
  get visibleLoopCount(): number {
    const count = this.loopCount;
    const now = this.rawMilliseconds() >>> 0;
    return (this.loopDeadline <= now ? count : count - 1) | 0;
  }
  private assertLive(): void {
    if (this.disposed) throw new DOMException('Aokana audio stream was disposed', 'AbortError');
    if (this.workerFailure !== null) throw this.workerFailure;
    if (this.bytesPerFrame === 0)
      throw new RangeError('Aokana stream divides by zero PCM frame size');
  }
  captureActor(): object | undefined {
    return this.actors?.currentActor;
  }
  private restartProducerLoop(actor?: object): void | Promise<void> {
    // Exchange source0's completion selects source1 without counting a repeat.
    if (!('countsLoopRestart' in this.decoder) || this.decoder.countsLoopRestart()) {
      const now = this.rawMilliseconds() >>> 0;
      this.loopCount = (this.loopCount + 1) >>> 0;
      this.loopDeadline = (now + 4000) >>> 0;
    }
    return this.decoder.restartLoop(actor);
  }
  private fillFrames(count: number, stopAtEof = false, actor?: object): void | Promise<void> {
    const operation = this.fillOperation(count, stopAtEof, actor);
    const resume = (value?: Uint8Array | void): void | Promise<void> => {
      for (;;) {
        const next = operation.next(value);
        if (next.done) return;
        if (next.value instanceof Promise) return next.value.then(resume);
        value = next.value;
      }
    };
    return resume();
  }
  private *fillOperation(
    count: number,
    stopAtEof: boolean,
    actor?: object,
  ): Generator<Uint8Array | void | Promise<Uint8Array | void>, void, Uint8Array | void> {
    let written = 0,
      stalled = false;
    while (written < count && !this.stopping) {
      this.assertLive();
      const requested = count - written,
        before = this.decoder.decodedFramePosition;
      const decoder = this.decoder;
      const live = 'dispose' in decoder;
      const bytes = (yield live
        ? decoder.readFrameBytes(requested, actor, (bytes) => {
            this.fifo.write(bytes);
          })
        : decoder.readFrameBytes(requested)) as Uint8Array;
      // Native pending mono sample writes separately from the lower returned frame count.
      const frames = (this.decoder.decodedFramePosition - before) >>> 0;
      if (!live) this.fifo.write(bytes);
      written = (written + frames) >>> 0;
      if (frames !== requested) {
        if (this.loopEnabled === 0) {
          if (stopAtEof) this.producerEnded = true;
          return;
        }
        yield this.restartProducerLoop(actor);
      }
      if (frames === 0 && stalled) yield new Promise<void>((resolve) => setTimeout(resolve, 0));
      stalled = frames === 0;
    }
  }
  private hold(operation: () => void | Promise<void>): void | Promise<void> {
    const previous = this.locked;
    const result = previous === null ? operation() : previous.then(operation);
    if (!(result instanceof Promise)) return;
    const locked = result.finally(() => {
      if (this.locked === locked) this.locked = null;
    });
    this.locked = locked;
    return locked;
  }
  /** 11c320 allocates/prefills, then 118940 clears the loop counters AFTER initialization. */
  initialize(actor = this.captureActor()): void | Promise<void> {
    if (this.stopping) throw new DOMException('Aokana live stream is stopping', 'AbortError');
    const finish = (): void => {
      this.loopCount = 0;
      this.loopDeadline = 0;
      this.scheduleWorker(0);
    };
    const result = this.hold(() => {
      this.assertLive();
      return this.fillFrames(Math.floor(this.fifo.capacity / this.bytesPerFrame), false, actor);
    });
    if (result instanceof Promise) return result.then(finish);
    finish();
  }
  private scheduleWorker(delay = 50): void {
    if (this.disposed || this.stopping || this.producerEnded || this.worker !== null) return;
    this.worker = setTimeout(() => {
      this.worker = null;
      try {
        const result = this.serviceProducer();
        if (result instanceof Promise)
          result.then(
            () => this.scheduleWorker(),
            (error: unknown) => {
              this.workerFailure = error;
            },
          );
        else this.scheduleWorker();
      } catch (error) {
        this.workerFailure = error;
      }
    }, delay);
  }
  /** One 11c1e0 worker wake: refill half-second chunks only while free bytes are strictly greater. */
  serviceProducer(): void | Promise<void> {
    if (this.stopping) return;
    return this.hold(() => {
      this.assertLive();
      const frames = this.sampleRate >>> 1,
        threshold = Math.imul(frames, this.bytesPerFrame) >>> 0;
      const run = (): void | Promise<void> => {
        while (!this.stopping && !this.producerEnded && this.fifo.free > threshold) {
          const result = this.fillFrames(frames, true, this.producerActor);
          if (result instanceof Promise) return result.then(run);
          if (frames === 0) return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(run);
        }
      };
      return run();
    });
  }
  readInto(
    destination: Uint8Array,
    offset: number,
    count: number,
    initialized?: Uint8Array,
  ): number | Promise<number> {
    if (this.stopping) throw new DOMException('Aokana live stream is stopping', 'AbortError');
    if (this.locked !== null)
      return this.locked.then(() => this.readInto(destination, offset, count, initialized));
    this.assertLive();
    count >>>= 0;
    const initialLength = this.sourceFrameCount;
    let written = 0;
    while (written < count && this.consumerPosition < initialLength) {
      const requested = Math.min(
        count - written,
        (this.sourceFrameCount - this.consumerPosition) >>> 0,
      );
      const gotBytes = this.fifo.readInto(
        destination,
        offset + Math.imul(written, this.bytesPerFrame),
        Math.imul(requested, this.bytesPerFrame) >>> 0,
        initialized,
      );
      const frames = Math.floor(gotBytes / this.bytesPerFrame);
      written += frames;
      this.consumerPosition = (this.consumerPosition + frames) >>> 0;
      if (this.consumerPosition === this.sourceFrameCount) {
        if (this.loopEnabled === 0) break;
        this.consumerPosition = this.decoder.loopStartFrame;
      } else if (frames < requested) break;
    }
    return written;
  }
  reset(actor = this.captureActor()): void | Promise<void> {
    if (this.stopping) throw new DOMException('Aokana live stream is stopping', 'AbortError');
    return this.hold(() => {
      this.assertLive();
      this.consumerPosition = 0;
      const finish = (): void | Promise<void> => {
        //1192C0 retains FIFO and worker state after resetting HF source/predictors.
        if (this.decoder.header.codec === 2) return;
        this.fifo.clear();
        return this.fillFrames(Math.floor(this.fifo.capacity / this.bytesPerFrame), false, actor);
      };
      const result = this.decoder.reset(actor);
      return result instanceof Promise ? result.then(finish) : finish();
    });
  }
  dispose(): void | Promise<void> {
    if (this.disposal !== null) return this.disposal;
    if (this.disposed) return;
    // Preserve the established memory-only cancellation profile. It owns no live input.
    if (!('dispose' in this.decoder)) {
      this.disposed = true;
      if (this.worker !== null) clearTimeout(this.worker);
      this.worker = null;
      this.fifo.clear();
      return;
    }
    this.stopping = true;
    if (this.worker !== null) {
      clearTimeout(this.worker);
      this.worker = null;
    }
    const finish = (): void | Promise<void> => {
      this.fifo.clear();
      this.disposed = true;
      if ('dispose' in this.decoder) return this.decoder.dispose();
    };
    //11C500 joins the producer before releasing FIFO;118C20 then releases input.
    if (this.locked !== null) {
      this.disposal = this.locked.then(finish, async (error) => {
        try {
          await finish();
        } catch {
          // Preserve the actual joined operation failure over a cleanup failure.
        }
        throw error;
      });
      return this.disposal;
    }
    if (this.workerFailure !== null) {
      const failure = this.workerFailure;
      this.disposal = (async () => {
        try {
          await finish();
        } catch {
          // Report the retained producer failure after attempting owned cleanup.
        }
        throw failure;
      })();
      return this.disposal;
    }
    const result = finish();
    if (result instanceof Promise) this.disposal = result;
    return result;
  }
}

export async function createAokanaWaveStream(
  bytes: Uint8Array,
  options: {readonly gain: number; readonly prefer24Bit: boolean},
  rawMilliseconds: () => number,
  Context?: typeof OfflineAudioContext,
): Promise<AokanaWaveStream> {
  const header = parseAokanaWaveBoxHeader(bytes);
  const decoder =
    header.codec === 3
      ? await createAokanaWaveBoxOggDecoder(bytes, options, Context)
      : createAokanaCustomWaveBoxDecoder(bytes, options);
  const stream = new AokanaWaveStream(decoder, rawMilliseconds);
  try {
    await stream.initialize();
    return stream;
  } catch (error) {
    try {
      await stream.dispose();
    } catch {
      // Preserve the actual initialization failure.
    }
    throw error;
  }
}

/** Actual live custom input; resource selection/header probe remains its separate caller. */
export async function createAokanaLiveWaveStream(
  storage: AokanaLiveAudioStorage,
  selectedCodec: 0 | 1 | 2,
  options: {readonly gain: number},
  rawMilliseconds: () => number,
  actors: AokanaLockActors,
  actor: object,
): Promise<AokanaWaveStream> {
  const decoder = await createAokanaLiveCustomWaveBoxDecoder(
    storage,
    selectedCodec,
    options,
    actor,
  );
  let stream: AokanaWaveStream | undefined;
  try {
    stream = new AokanaWaveStream(decoder, rawMilliseconds, actors);
    await stream.initialize(actor);
    return stream;
  } catch (error) {
    try {
      await (stream === undefined ? decoder.dispose() : stream.dispose());
    } catch {
      // Preserve the actual initialization failure.
    }
    throw error;
  }
}

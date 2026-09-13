import {createAokanaCustomWaveBoxDecoder, type AokanaWaveBoxDecoder} from './wavebox-codecs.js';
import {parseAokanaWaveBoxHeader} from './wavebox-header.js';
import {createAokanaWaveBoxOggDecoder, type AokanaWaveBoxOggDecoder} from './wavebox-ogg.js';

export type AokanaWaveDecoder = AokanaWaveBoxDecoder | AokanaWaveBoxOggDecoder;

/** CRotateBuffer/CRotateBufferSecurity: independently wrapping read/write positions and byte fill count. */
export class AokanaWaveFifo {
  readonly storage: Uint8Array;
  private readPosition = 0;
  private writePosition = 0;
  private filled = 0;
  constructor(readonly capacity: number) {this.storage = new Uint8Array(capacity >>> 0);}
  get available(): number {return this.filled;}
  get free(): number {return (this.capacity - this.filled) >>> 0;}
  clear(): void {this.readPosition = this.writePosition = this.filled = 0;}
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
  readInto(destination: Uint8Array, offset: number, length: number): number {
    const count = Math.min(this.filled, length >>> 0);
    if (offset < 0 || offset + count > destination.length) throw new RangeError('Aokana audio read crosses native destination allocation');
    if (count === 0) return 0;
    const first = Math.min(count, this.capacity - this.readPosition);
    destination.set(this.storage.subarray(this.readPosition, this.readPosition + first), offset);
    destination.set(this.storage.subarray(0, count - first), offset + first);
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
  private worker: ReturnType<typeof setTimeout> | null = null;
  private locked: Promise<void> | null = null;
  private workerFailure: unknown = null;
  constructor(readonly decoder: AokanaWaveDecoder, readonly rawMilliseconds: () => number) {
    this.bytesPerFrame = Math.imul(decoder.channels, decoder.outputBits >>> 3) >>> 0;
    this.fifo = new AokanaWaveFifo(Math.imul(Math.imul(4, decoder.sampleRate), this.bytesPerFrame) >>> 0);
  }
  get framePosition(): number {return this.consumerPosition;}
  get sourceFrameCount(): number {return this.decoder.sourceFrameCount;}
  get loopEnabled(): number {return this.decoder.loopEnabled;}
  get sampleRate(): number {return this.decoder.sampleRate;}
  get channels(): number {return this.decoder.channels;}
  get outputBits(): 16 | 24 {return this.decoder.outputBits;}
  get visibleLoopCount(): number {
    const now = this.rawMilliseconds() >>> 0;
    return (this.loopDeadline <= now ? this.loopCount : this.loopCount - 1) | 0;
  }
  private assertLive(): void {
    if (this.disposed) throw new DOMException('Aokana audio stream was disposed', 'AbortError');
    if (this.workerFailure !== null) throw this.workerFailure;
    if (this.bytesPerFrame === 0) throw new RangeError('Aokana stream divides by zero PCM frame size');
  }
  private restartProducerLoop(): void {
    this.loopCount = (this.loopCount + 1) >>> 0;
    this.loopDeadline = ((this.rawMilliseconds() >>> 0) + 4000) >>> 0;
    this.decoder.restartLoop();
  }
  private fillFrames(count: number, stopAtEof = false, written = 0, stalled = false): void | Promise<void> {
    while (written < count) {
      this.assertLive();
      const requested = count - written, before = this.decoder.decodedFramePosition;
      const bytes = this.decoder.readFrameBytes(requested);
      // The mono ADPCM cached sample can write bytes without incrementing the lower return count.
      const frames = (this.decoder.decodedFramePosition - before) >>> 0;
      this.fifo.write(bytes);
      written = (written + frames) >>> 0;
      if (frames !== requested) {
        if (this.loopEnabled === 0) {if (stopAtEof) this.producerEnded = true; return;}
        this.restartProducerLoop();
      }
      if (frames === 0 && stalled) {
        // A zero-length loop holds the native producer lock indefinitely. Yield a host task so
        // disposal can interrupt the corresponding worker without inventing EOF or silence.
        return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => this.fillFrames(count, stopAtEof, written, true));
      }
      stalled = frames === 0;
    }
  }
  private hold(operation: () => void | Promise<void>): void | Promise<void> {
    const previous = this.locked;
    const result = previous === null ? operation() : previous.then(operation);
    if (!(result instanceof Promise)) return;
    const locked = result.finally(() => {if (this.locked === locked) this.locked = null;});
    this.locked = locked;
    return locked;
  }
  /** 11c320 allocates/prefills, then 118940 clears the loop counters AFTER initialization. */
  initialize(): void | Promise<void> {
    const finish = (): void => {this.loopCount = 0; this.loopDeadline = 0; this.scheduleWorker(0);};
    const result = this.hold(() => {this.assertLive(); return this.fillFrames(Math.floor(this.fifo.capacity / this.bytesPerFrame));});
    if (result instanceof Promise) return result.then(finish);
    finish();
  }
  private scheduleWorker(delay = 50): void {
    if (this.disposed || this.producerEnded || this.worker !== null) return;
    this.worker = setTimeout(() => {
      this.worker = null;
      try {
        const result = this.serviceProducer();
        if (result instanceof Promise) result.then(() => this.scheduleWorker(), (error: unknown) => {this.workerFailure = error;});
        else this.scheduleWorker();
      } catch (error) {this.workerFailure = error;}
    }, delay);
  }
  /** One 11c1e0 worker wake: refill half-second chunks only while free bytes are strictly greater. */
  serviceProducer(): void | Promise<void> {
    return this.hold(() => {
      this.assertLive();
      const frames = this.sampleRate >>> 1, threshold = Math.imul(frames, this.bytesPerFrame) >>> 0;
      const run = (): void | Promise<void> => {
        while (!this.producerEnded && this.fifo.free > threshold) {
          const result = this.fillFrames(frames, true);
          if (result instanceof Promise) return result.then(run);
          if (frames === 0) return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(run);
        }
      };
      return run();
    });
  }
  readInto(destination: Uint8Array, offset: number, count: number): number | Promise<number> {
    if (this.locked !== null) return this.locked.then(() => this.readInto(destination, offset, count));
    this.assertLive();
    count >>>= 0;
    const initialLength = this.sourceFrameCount;
    let written = 0;
    while (written < count && this.consumerPosition < initialLength) {
      const requested = Math.min(count - written, (this.sourceFrameCount - this.consumerPosition) >>> 0);
      const gotBytes = this.fifo.readInto(destination, offset + Math.imul(written, this.bytesPerFrame), Math.imul(requested, this.bytesPerFrame) >>> 0);
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
  reset(): void | Promise<void> {
    return this.hold(() => {
      this.assertLive();
      this.consumerPosition = 0;
      this.decoder.reset();
      // HFADPCM8's actual reset omits 11c430, retaining the existing FIFO bytes and worker state.
      if (this.decoder.header.codec === 2) return;
      this.fifo.clear();
      return this.fillFrames(Math.floor(this.fifo.capacity / this.bytesPerFrame));
    });
  }
  dispose(): void {
    this.disposed = true;
    if (this.worker !== null) {clearTimeout(this.worker); this.worker = null;}
    this.fifo.clear();
  }
}

export async function createAokanaWaveStream(
  bytes: Uint8Array,
  options: {readonly gain: number; readonly prefer24Bit: boolean},
  rawMilliseconds: () => number,
  Context?: typeof OfflineAudioContext,
): Promise<AokanaWaveStream> {
  const header = parseAokanaWaveBoxHeader(bytes);
  const decoder = header.codec === 3 ? await createAokanaWaveBoxOggDecoder(bytes, options, Context) : createAokanaCustomWaveBoxDecoder(bytes, options);
  const stream = new AokanaWaveStream(decoder, rawMilliseconds);
  try {await stream.initialize(); return stream;}
  catch (error) {stream.dispose(); throw error;}
}

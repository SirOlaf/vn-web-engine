import {burikoRosettaSseReciprocal} from '../cpu-numerical-profile.js';
import {
  createBurikoCustomWaveBoxDecoder,
  createBurikoLiveCustomWaveBoxDecoder,
} from './wavebox-codecs.js';
import type {BurikoLiveAudioStorage} from './live-storage.js';
import {parseBurikoWaveBoxHeader, type BurikoWaveBoxHeader} from './wavebox-header.js';
import {createBurikoWaveBoxOggDecoder, type BurikoWaveBoxOggOptions} from './wavebox-ogg.js';
import type {BurikoWaveDecoder} from './wave-stream.js';
import type {BurikoPcmStorage} from './static-pcm.js';

const f32 = Math.fround;
function requirePcm(storage: BurikoPcmStorage, start: number, count: number): void {
  if (count === 0) return;
  if (!Number.isSafeInteger(start) || start < 0 || start + count > storage.bytes.length)
    throw new RangeError('Buriko static WaveBox access crosses the native PCM allocation');
  if (storage.initialized.subarray(start, start + count).includes(0))
    throw new Error('Buriko static WaveBox reads unwritten native PCM bytes');
}

/** 11c8a0: the static model's +70 argument is a millisecond fade-in, with DWORD products. */
export function fadeInBurikoStaticPcm(
  pcm: BurikoPcmStorage,
  frameCount: number,
  sampleRate: number,
  channels: number,
  bits: 16 | 24,
  milliseconds: number,
): number {
  milliseconds >>>= 0;
  sampleRate >>>= 0;
  channels >>>= 0;
  const frames =
    (Math.floor((Math.imul(milliseconds % 1000, sampleRate) >>> 0) / 1000) +
      Math.imul(sampleRate, Math.floor(milliseconds / 1000))) >>>
    0;
  if (frames > frameCount >>> 0) return 0xffffffff;
  if (frames === 0) return 0; // RCPSS(0) produces NaN in refinement, but no sample consumes it.
  const seed = burikoRosettaSseReciprocal(f32(frames));
  const reciprocal = f32(f32(seed + seed) - f32(f32(frames) * f32(seed * seed)));
  const width = bits >>> 3,
    data = new DataView(pcm.bytes.buffer, pcm.bytes.byteOffset, pcm.bytes.byteLength);
  let offset = 0;
  for (let frame = 0; frame < frames; frame++)
    for (let channel = 0; channel < channels; channel++, offset += width) {
      requirePcm(pcm, offset, width);
      const sample =
        bits === 16
          ? data.getInt16(offset, true)
          : ((pcm.bytes[offset]! |
              (pcm.bytes[offset + 1]! << 8) |
              (pcm.bytes[offset + 2]! << 16)) <<
              8) >>
            8;
      let value = f32(f32(Math.imul(sample, frame)) * reciprocal);
      const floor = f32(Math.floor(value)),
        fraction = f32(value - floor),
        epsilon = 2 ** -14;
      if (f32(1 - epsilon) <= fraction) value = f32(Math.ceil(value));
      else if (fraction <= epsilon) value = floor;
      const rounded = Math.floor(f32(value + 0.5));
      const integer =
        !Number.isFinite(rounded) || rounded < -2147483648 || rounded > 2147483647
          ? -2147483648
          : rounded;
      for (let byte = 0; byte < width; byte++)
        pcm.bytes[offset + byte] = (integer >> (byte * 8)) & 255;
    }
  return 0;
}

/** CStaticBurikoWaveBox{ADPCM4,PCM16,HFADPCM8,OGG}: decoded CMemoryStorage, not a stream FIFO. */
export class BurikoWaveStatic {
  readonly pcm: BurikoPcmStorage;
  readonly bytesPerFrame: number;
  private consumerPosition = 0;
  private sourcePosition = 0;
  private disposed = false;
  constructor(
    readonly header: BurikoWaveBoxHeader,
    readonly outputBits: 16 | 24,
    decoded: Uint8Array,
  ) {
    this.bytesPerFrame = Math.imul(header.channels, outputBits >>> 3) >>> 0;
    // These intentionally differ. 11b710 uses compressed-byte field08*4; PCM uses field08.
    const capacity =
      header.codec === 0
        ? (header.field08 << 2) >>> 0
        : header.codec === 1
          ? header.field08
          : Math.imul(this.bytesPerFrame, header.sourceFrameCount) >>> 0;
    const bytes = new Uint8Array(capacity),
      initialized = new Uint8Array(capacity);
    this.pcm = {bytes, initialized};
    this.appendDecoded(decoded);
    this.seek(0);
  }
  /** Actual fixed-capacity CMemoryStorage write; unwritten suffix remains undefined. */
  private appendDecoded(bytes: Uint8Array): void {
    const written = Math.min(this.pcm.bytes.length - this.sourcePosition, bytes.length);
    this.pcm.bytes.set(bytes.subarray(0, written), this.sourcePosition);
    this.pcm.initialized.fill(1, this.sourcePosition, this.sourcePosition + written);
    this.sourcePosition += written;
  }
  /**11B710/930/BB40 replace live input with decoded memory before releasing that input. */
  static async fromLiveInput(
    input: BurikoLiveAudioStorage,
    selectedCodec: 0 | 1 | 2,
    options: {readonly gain: number},
    actor: object,
  ): Promise<BurikoWaveStatic> {
    const decoder = await createBurikoLiveCustomWaveBoxDecoder(
      input,
      selectedCodec,
      options,
      actor,
    );
    let wave: BurikoWaveStatic | undefined;
    let closingInput = false;
    try {
      wave = new BurikoWaveStatic(decoder.header, decoder.outputBits, new Uint8Array());
      const memory = wave;
      await decoder.readFrameBytes(decoder.sourceFrameCount, actor, (bytes) =>
        memory.appendDecoded(bytes),
      );
      memory.seek(0);
      closingInput = true;
      await decoder.dispose();
      return memory;
    } catch (error) {
      if (!closingInput) {
        try {
          await decoder.dispose();
        } catch {
          /* Keep the primary construction/read failure. */
        }
      }
      wave?.dispose();
      throw error;
    }
  }
  get sourceFrameCount(): number {
    return this.header.sourceFrameCount;
  }
  get sampleRate(): number {
    return this.header.sampleRate;
  }
  get channels(): number {
    return this.header.channels;
  }
  get framePosition(): number {
    return this.consumerPosition;
  }
  get loopEnabled(): number {
    return this.header.loopEnabled;
  }
  get visibleLoopCount(): number {
    return 0;
  }
  private assertLive(): void {
    if (this.disposed) throw new DOMException('Buriko static WaveBox was disposed', 'AbortError');
  }
  private seek(offset: number): void {
    offset >>>= 0;
    // CMemoryStorage seek reports zero even when rejecting an out-of-capacity position.
    if (offset <= this.pcm.bytes.length) this.sourcePosition = offset;
  }
  reset(): void {
    this.assertLive();
    this.consumerPosition = 0;
    this.seek(0);
  }
  private restartLoop(): void {
    this.consumerPosition = this.header.loopStartFrame;
    // The PCM/HF static overrides use sourceFrameCount here, not bytesPerFrame.
    const byteOffset =
      this.header.codec === 1
        ? (Math.imul(this.header.sourceFrameCount, this.header.loopStartFrame) >>> 0) >>> 2
        : Math.imul(
            this.header.codec === 2 ? this.header.sourceFrameCount : this.bytesPerFrame,
            this.header.loopStartFrame,
          );
    this.seek(byteOffset);
  }
  fadeIn(milliseconds: number): number {
    this.assertLive();
    return fadeInBurikoStaticPcm(
      this.pcm,
      this.sourceFrameCount,
      this.sampleRate,
      this.channels,
      this.outputBits,
      milliseconds,
    );
  }
  /** 11c060 preserves the CMemoryStorage EOF sentinel in its unsigned frame-count arithmetic. */
  readInto(
    destination: Uint8Array,
    offset: number,
    count: number,
    initialized?: Uint8Array,
  ): number {
    this.assertLive();
    count >>>= 0;
    let consumed = 0;
    while (consumed < count && this.consumerPosition < this.sourceFrameCount) {
      const requested = Math.min(
        count - consumed,
        (this.sourceFrameCount - this.consumerPosition) >>> 0,
      );
      const byteCount = Math.imul(requested, this.bytesPerFrame) >>> 0;
      let returned = 0xffffffff;
      if (this.sourcePosition < this.pcm.bytes.length) {
        returned = Math.min(this.pcm.bytes.length - this.sourcePosition, byteCount);
        requirePcm(this.pcm, this.sourcePosition, returned);
        const at = offset + (Math.imul(this.bytesPerFrame, consumed) >>> 0);
        if (returned !== 0 && (at < 0 || at + returned > destination.length))
          throw new RangeError('Buriko static WaveBox read crosses native destination allocation');
        if (returned !== 0) {
          if (initialized !== undefined && at + returned > initialized.length)
            throw new RangeError('Buriko static read exceeds destination initialization storage');
          destination.set(
            this.pcm.bytes.subarray(this.sourcePosition, this.sourcePosition + returned),
            at,
          );
          initialized?.fill(1, at, at + returned);
        }
        this.sourcePosition += returned;
      }
      if (this.bytesPerFrame === 0)
        throw new RangeError('Buriko static WaveBox divides by zero frame size');
      const frames = Math.floor(returned / this.bytesPerFrame);
      consumed = (consumed + frames) >>> 0;
      this.consumerPosition = (this.consumerPosition + frames) >>> 0;
      if (this.consumerPosition === this.sourceFrameCount) {
        if (this.loopEnabled === 0) break;
        this.restartLoop();
      } else if (frames < requested) break;
    }
    return consumed;
  }
  dispose(): void {
    this.disposed = true;
  }
}

export async function createBurikoWaveStatic(
  bytes: Uint8Array,
  options: BurikoWaveBoxOggOptions,
  Context?: typeof OfflineAudioContext,
): Promise<BurikoWaveStatic> {
  const header = parseBurikoWaveBoxHeader(bytes);
  const decoder: BurikoWaveDecoder =
    header.codec === 3
      ? await createBurikoWaveBoxOggDecoder(bytes, options, Context)
      : createBurikoCustomWaveBoxDecoder(bytes, options);
  const decoded = await decoder.readFrameBytes(header.sourceFrameCount);
  return new BurikoWaveStatic(header, decoder.outputBits, decoded);
}

/** Lower-only live custom input factory; the resource selector supplies codec and cursor0. */
export function createBurikoLiveWaveStatic(
  input: BurikoLiveAudioStorage,
  selectedCodec: 0 | 1 | 2,
  options: {readonly gain: number},
  actor: object,
): Promise<BurikoWaveStatic> {
  return BurikoWaveStatic.fromLiveInput(input, selectedCodec, options, actor);
}

import {
  streamVorbis,
  VorbisDecodeError,
  type VorbisStream,
} from '../../../../audio/vorbis-decoder.js';
import type {BurikoLiveAudioStorage} from './live-storage.js';
import {parseBurikoOggVorbisLinks, type BurikoVorbisPcmLink} from './ogg-vorbis.js';
import {BurikoWaveBoxError, parseBurikoWaveBoxHeader} from './wavebox-header.js';
import {BurikoWaveBoxOggDecoder, type BurikoWaveBoxOggOptions} from './wavebox-ogg.js';
import type {BurikoWaveEffect} from './wavebox-codecs.js';

/** The first chunk covers the stream's four-second prefill with a margin. */
const FIRST_SECONDS = 5;
const CHUNK_SECONDS = 10;
/** Plausibility bounds before preallocating from an EOS granule. */
const MAX_FRAMES_PER_ENCODED_BYTE = 256;
const MAX_PREALLOCATED_SAMPLES = 1 << 28;

function rejectedVorbis(error: unknown): unknown {
  return error instanceof VorbisDecodeError
    ? new BurikoWaveBoxError(0x10000000, 'Vorbis rejected Buriko compressed audio')
    : error;
}

/**
 * One Vorbis link whose PCM arrives from `streamVorbis` in order. With an EOS granule, planes
 * are allocated to that bound and `frames` holds it until the decode finishes, when both
 * become exact. Frames below `stableFrames` never change afterwards: EOS trimming only
 * removes frames at or beyond the granule.
 */
class ProgressiveVorbisLink implements BurikoVorbisPcmLink {
  planes: Float32Array[] = [];
  frames = 0;
  private decoded = 0;
  private capacity: number | null = null;
  private collected: Float32Array[][] = [];
  complete = false;
  failure: unknown = null;
  /** Each returns true once it has settled its promise. */
  private waiters: (() => boolean)[] = [];
  private readonly stream: VorbisStream;
  constructor(
    readonly channels: number,
    readonly sampleRate: number,
    readonly shortBlock: number,
    readonly longBlock: number,
    encoded: Uint8Array,
    readonly firstFrames: number,
    chunkFrames: number,
  ) {
    this.stream = streamVorbis(encoded, firstFrames, chunkFrames, {
      onOpen: ({sampleRate: rate, channels: count, finalGranule}) => {
        if (rate !== sampleRate || count !== channels) {
          this.fail(new Error('Vorbis decoder changed the identified Buriko PCM geometry'));
          return;
        }
        if (
          finalGranule !== null &&
          finalGranule <= encoded.length * MAX_FRAMES_PER_ENCODED_BYTE &&
          finalGranule * channels <= MAX_PREALLOCATED_SAMPLES
        ) {
          this.capacity = this.frames = finalGranule;
          this.planes = Array.from({length: channels}, () => new Float32Array(finalGranule));
        }
      },
      onChunk: (planes, frames) => {
        if (this.failure !== null) return;
        if (this.capacity === null) this.collected.push(planes);
        else {
          const kept = Math.max(0, Math.min(frames, this.capacity - this.decoded));
          for (let channel = 0; channel < channels; channel++)
            this.planes[channel]!.set(planes[channel]!.subarray(0, kept), this.decoded);
        }
        this.decoded += frames;
        this.notify();
      },
    });
    this.stream.done.then(
      ({frames}) => {
        if (this.failure !== null) return;
        if (this.capacity === null) {
          this.planes = Array.from({length: channels}, (_, channel) => {
            const plane = new Float32Array(frames);
            let at = 0;
            for (const chunk of this.collected) {
              if (at >= frames) break;
              const part = chunk[channel]!.subarray(0, frames - at);
              plane.set(part, at);
              at += part.length;
            }
            return plane;
          });
          this.collected = [];
        } else this.planes = this.planes.map((plane) => plane.subarray(0, frames));
        this.frames = frames;
        this.complete = true;
        this.notify();
      },
      (error: unknown) => this.fail(rejectedVorbis(error)),
    );
  }
  /** Frames the finished decode will contain with the same samples. */
  get stableFrames(): number {
    if (this.complete) return this.frames;
    return this.capacity === null ? 0 : Math.min(this.decoded, this.capacity);
  }
  /** True when frames `[0, end)` read now equal the finished decode's. */
  covers(end: number): boolean {
    return this.complete || end <= this.stableFrames;
  }
  /** Resolves once `covers(end)`; rejects with the decode failure if it cannot. */
  wait(end: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = (): boolean => {
        if (this.covers(end)) resolve();
        else if (this.failure !== null) reject(this.failure);
        else return false;
        return true;
      };
      if (!check()) this.waiters.push(check);
    });
  }
  cancel(): void {
    this.stream.cancel();
    this.fail(new DOMException('Buriko Vorbis stream was disposed', 'AbortError'));
  }
  private fail(error: unknown): void {
    if (this.failure !== null || this.complete) return;
    this.failure = error;
    this.stream.cancel();
    this.collected = [];
    this.notify();
  }
  private notify(): void {
    this.waiters = this.waiters.filter((settle) => !settle());
  }
}

/**
 * CWaveStreamCtrl's Ogg producer over a progressively decoded link. Every read and loop seek
 * waits until the frames it depends on are final, then runs the complete-PCM reader
 * unchanged, so the produced bytes equal a fully decoded track's. A decode failure surfaces
 * at the first read that needs frames beyond the failed packet, not when the stream opens.
 */
export class BurikoProgressiveOggDecoder {
  private constructor(
    private readonly reader: BurikoWaveBoxOggDecoder,
    private readonly link: ProgressiveVorbisLink,
    private readonly input: BurikoLiveAudioStorage,
  ) {}
  /**
   * Returns null for inputs this decoder does not stream (chained links), which keep complete
   * decoding. Header and first-chunk failures reject here, as complete decoding does.
   */
  static async open(
    bytes: Uint8Array,
    options: BurikoWaveBoxOggOptions,
    input: BurikoLiveAudioStorage,
    /** Frame counts of the first and later chunks; tests shrink them. */
    chunking?: {readonly first: number; readonly chunk: number},
  ): Promise<BurikoProgressiveOggDecoder | null> {
    const header = parseBurikoWaveBoxHeader(bytes);
    if (header.codec !== 3)
      throw new BurikoWaveBoxError(0x11000004, 'Buriko Ogg model requires codec3');
    // Native callbacks expose physical byte64 as Ogg offset0, independent of header.resetDataOffset.
    const links = parseBurikoOggVorbisLinks(bytes.subarray(64));
    if (links.length !== 1) return null;
    const {channels, sampleRate, shortBlock, longBlock, bytes: encoded} = links[0]!;
    const link = new ProgressiveVorbisLink(
      channels,
      sampleRate,
      shortBlock,
      longBlock,
      encoded,
      chunking?.first ?? FIRST_SECONDS * sampleRate,
      chunking?.chunk ?? CHUNK_SECONDS * sampleRate,
    );
    try {
      await link.wait(link.firstFrames);
    } catch (error) {
      link.cancel();
      throw error;
    }
    const reader = new BurikoWaveBoxOggDecoder(
      header,
      [link],
      options.prefer24Bit && options.abi?.compatibility !== '1.69' ? 24 : 16,
      options.gain,
      options.abi,
    );
    return new BurikoProgressiveOggDecoder(reader, link, input);
  }
  get header() {
    return this.reader.header;
  }
  get sourceFrameCount(): number {
    return this.reader.sourceFrameCount;
  }
  get sampleRate(): number {
    return this.reader.sampleRate;
  }
  get channels(): number {
    return this.reader.channels;
  }
  get outputBits(): 16 | 24 {
    return this.reader.outputBits;
  }
  get loopEnabled(): number {
    return this.reader.loopEnabled;
  }
  get loopStartFrame(): number {
    return this.reader.loopStartFrame;
  }
  get decodedFramePosition(): number {
    return this.reader.decodedFramePosition;
  }
  overrideLoop(enabled: number): void {
    this.reader.overrideLoop(enabled);
  }
  reset(): void {
    this.reader.reset();
  }
  readFrameBytes(
    count: number,
    _actor?: object,
    publish?: (bytes: Uint8Array) => void,
  ): BurikoWaveEffect<Uint8Array> {
    // The complete reader first clamps to the header's frame count, then to decoded PCM.
    const requested = Math.min(
      count >>> 0,
      (this.reader.sourceFrameCount - this.reader.decodedFramePosition) >>> 0,
    );
    const end = this.reader.sourceFramePosition + requested;
    if (!this.link.covers(end))
      return this.link.wait(end).then(() => this.readFrameBytes(count, _actor, publish));
    const bytes = this.reader.readFrameBytes(count);
    if (publish === undefined) return bytes;
    publish(bytes);
    return new Uint8Array(0);
  }
  restartLoop(): BurikoWaveEffect<void> {
    // ov_pcm_seek's bound needs the final length only past the stable frames.
    const start = this.reader.loopStartFrame;
    if (this.link.covers(start)) return this.reader.restartLoop();
    return this.link.wait(Number.POSITIVE_INFINITY).then(() => this.reader.restartLoop());
  }
  dispose(): BurikoWaveEffect<void> {
    this.link.cancel();
    return this.input.dispose();
  }
}

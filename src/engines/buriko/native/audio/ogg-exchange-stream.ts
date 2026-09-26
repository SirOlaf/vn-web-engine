import type {BurikoLockActors} from '../exclusion-locks.js';
import {materializeBurikoLiveOgg} from './live-ogg-stream.js';
import type {BurikoWaveBoxOggOptions} from './wavebox-ogg.js';
import type {BurikoLiveAudioStorage} from './live-storage.js';
import {
  BurikoWaveBoxError,
  requireBurikoWaveHeaderBytes,
  type BurikoWaveBoxHeader,
} from './wavebox-header.js';
import {BurikoWaveBoxOggDecoder} from './wavebox-ogg.js';
import {BurikoWaveStream} from './wave-stream.js';

/** 1198F0 releases input0 before input1, including when the first release fails. */
async function disposeExchangeStorages(
  first: BurikoLiveAudioStorage,
  second: BurikoLiveAudioStorage,
): Promise<void> {
  let firstFailure: unknown,
    failed = false;
  try {
    await first.dispose();
  } catch (error) {
    firstFailure = error;
    failed = true;
  }
  try {
    await second.dispose();
  } catch (error) {
    if (!failed) {
      firstFailure = error;
      failed = true;
    }
  }
  if (failed) throw firstFailure;
}

/** 119FE0/119D60/1199C0: two retained Vorbis inputs behind one stream controller. */
export class BurikoOggExchangeDecoder extends BurikoWaveBoxOggDecoder {
  private selected = 0;
  private position = 0;
  private secondLoop: number;
  private disposal: Promise<void> | null = null;

  constructor(
    readonly first: BurikoWaveBoxOggDecoder,
    readonly second: BurikoWaveBoxOggDecoder,
    private readonly firstStorage: BurikoLiveAudioStorage,
    private readonly secondStorage: BurikoLiveAudioStorage,
    rawLoopDword: number,
  ) {
    super(first.header, first.links, first.outputBits, first.gain);
    this.secondLoop = rawLoopDword >>> 0;
  }

  get activeInput(): 0 | 1 {
    return this.selected as 0 | 1;
  }
  get activeHeader(): BurikoWaveBoxHeader {
    return this.selected === 0 ? this.first.header : this.second.header;
  }
  /** CWaveStreamCtrl is allocated from the first header's PCM geometry. */
  override get channels(): number {
    return this.first.channels;
  }
  override get sampleRate(): number {
    return this.first.sampleRate;
  }
  /** Exchange +0x18/119D30 reports both header frame counts to the consumer. */
  override get sourceFrameCount(): number {
    return (this.first.sourceFrameCount + this.second.sourceFrameCount) >>> 0;
  }
  override get decodedFramePosition(): number {
    return this.position;
  }
  /** 119D10 always advances source0, then consults +B64 only for source1. */
  override get loopEnabled(): number {
    return this.selected === 0 ? 1 : this.secondLoop;
  }
  /** 119AE0 restarts the consumer's logical frame position at zero. */
  override get loopStartFrame(): number {
    return 0;
  }
  override overrideLoop(enabled: number): void {
    this.secondLoop = enabled >>> 0;
  }
  /** 1199C0 counts only a completion that repeats input1. */
  countsLoopRestart(): boolean {
    return this.selected === 1;
  }

  override reset(): void {
    // 119A40 seeks input1 before input0, then makes input0 current.
    this.second.reset();
    this.first.reset();
    this.selected = 0;
    this.position = 0;
  }

  override restartLoop(): void {
    if (this.selected === 0) this.selected = 1;
    else this.second.reset();
    this.position = this.first.sourceFrameCount;
  }

  override readFrameBytes(
    count: number,
    _actor?: object,
    publish?: (bytes: Uint8Array) => void,
  ): Uint8Array {
    const decoder = this.selected === 0 ? this.first : this.second,
      before = decoder.decodedFramePosition,
      bytes = decoder.readFrameBytes(count >>> 0),
      frames = (decoder.decodedFramePosition - before) >>> 0;
    this.position = (this.position + frames) >>> 0;
    if (publish === undefined) return bytes;
    publish(bytes);
    return new Uint8Array(0);
  }

  dispose(): Promise<void> {
    if (this.disposal !== null) return this.disposal;
    this.disposal = disposeExchangeStorages(this.firstStorage, this.secondStorage);
    return this.disposal;
  }
}

/** 113650's independent selector reads. The model performs its own later header reads. */
async function selectorCodec(input: BurikoLiveAudioStorage, actor: object): Promise<number> {
  const scratch = new Uint8Array(64),
    initialized = new Uint8Array(64);
  const count = (await input.readInto({bytes: scratch, offset: 0}, 64, actor, initialized)) >>> 0;
  if (count < 64)
    throw new BurikoWaveBoxError(14, 'Buriko Ogg exchange selector read a short header');
  requireBurikoWaveHeaderBytes(initialized, 48, 4);
  return new DataView(scratch.buffer).getUint32(48, true);
}

/** Takes both live storages on entry; success transfers them to the stream, failure releases both. */
export async function createBurikoLiveOggExchangeWaveStream(
  first: BurikoLiveAudioStorage,
  second: BurikoLiveAudioStorage,
  rawLoopDword: number,
  options: BurikoWaveBoxOggOptions,
  rawMilliseconds: () => number,
  actors: BurikoLockActors,
  actor: object,
  Context?: typeof OfflineAudioContext,
): Promise<BurikoWaveStream> {
  let exchange: BurikoOggExchangeDecoder | undefined, stream: BurikoWaveStream | undefined;
  try {
    const firstCodec = await selectorCodec(first, actor),
      secondCodec = await selectorCodec(second, actor);
    if (firstCodec !== secondCodec || firstCodec !== 3)
      throw new BurikoWaveBoxError(14, 'Buriko Ogg exchange requires matching codec3 inputs');
    await first.seek(0, actor);
    await second.seek(0, actor);
    // 119B10 opens the second Vorbis chain before the first.
    const secondDecoder = await materializeBurikoLiveOgg(second, options, actor, Context),
      firstDecoder = await materializeBurikoLiveOgg(first, options, actor, Context);
    exchange = new BurikoOggExchangeDecoder(
      firstDecoder,
      secondDecoder,
      first,
      second,
      rawLoopDword,
    );
    stream = new BurikoWaveStream(exchange, rawMilliseconds, actors, options.abi);
    await stream.initialize(actor);
    return stream;
  } catch (error) {
    try {
      if (stream !== undefined) await stream.dispose();
      else if (exchange !== undefined) await exchange.dispose();
      else await disposeExchangeStorages(first, second);
    } catch {
      // Preserve the selector, model, or actual browser-decoder failure.
    }
    if (error instanceof BurikoWaveBoxError && error.nativeCode !== 14)
      throw new BurikoWaveBoxError(14, 'Buriko Ogg exchange model rejected its input');
    throw error;
  }
}

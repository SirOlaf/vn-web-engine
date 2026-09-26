import {burikoAudioPanDecibels, burikoAudioVolumeDecibels} from '../audio-levels.js';
import {timeScaleBurikoStaticPcm, type BurikoPcmStorage} from './static-pcm.js';
import type {BurikoSpeakerBackend, BurikoSpeakerBuffer} from './speaker-backend.js';
import type {BurikoSpeakerModel} from './speaker-model.js';
import {BURIKO_BP_ABI_172, type BurikoBpAbi} from '../../bp/abi.js';
import {
  accelerateBurikoLegacy169StaticPcm,
  burikoLegacy169AcceleratedFrames,
} from './legacy-169-static-pcm.js';

export interface BurikoSpeakerDescriptor {
  readonly waveFormat: Uint8Array;
  readonly flags: number;
  readonly byteLength: number;
  readonly frames: number;
}
/** Selected host initialization/error state shared by actual speakers. Registry owns lifetime. */
export class BurikoSpeakerContext {
  initialized = true;
  lastError = 0;
  constructor(
    readonly backend: BurikoSpeakerBackend,
    readonly abi: BurikoBpAbi = BURIKO_BP_ABI_172,
  ) {}
}
const unsignedConversion = (value: number): number => {
  const integer = Math.trunc(value);
  return !Number.isFinite(integer) ||
    integer < -9223372036854775808 ||
    integer >= 9223372036854775808
    ? 0
    : Number(BigInt.asUintN(32, BigInt(integer)));
};
/** Common118340/118520/1185F0/118680 and actual static virtuals. */
export class BurikoStaticSpeaker {
  model: BurikoSpeakerModel | null = null;
  protected buffer: BurikoSpeakerBuffer | null = null;
  protected storage: BurikoPcmStorage | null = null;
  ready = false;
  rate = 1;
  private legacyAcceleration = 0;
  attenuation = 0;
  pan = 0;
  descriptor: BurikoSpeakerDescriptor | null = null;
  constructor(readonly context: BurikoSpeakerContext) {}
  protected notReady(): number {
    this.context.lastError = 2;
    return 2;
  }
  protected actualBuffer(): BurikoSpeakerBuffer {
    if (this.buffer === null) throw new Error('Buriko speaker dereferences absent native buffer');
    return this.buffer;
  }
  protected actualModel(): BurikoSpeakerModel {
    if (this.model === null) throw new Error('Buriko speaker dereferences absent native model');
    return this.model;
  }
  protected looping(): boolean {
    return false;
  }
  protected makeDescriptor(model: BurikoSpeakerModel): BurikoSpeakerDescriptor {
    let frames = model.frames >>> 0;
    if (this.context.abi.compatibility === '1.69') {
      if (this.legacyAcceleration !== 0)
        frames = burikoLegacy169AcceleratedFrames(frames, model.sampleRate);
    } else if (this.rate !== 1) {
      const step = unsignedConversion((model.sampleRate >>> 0) * 0.03);
      if (step === 0) throw new RangeError('Buriko static descriptor divides by zero30ms frames');
      const estimate = unsignedConversion(frames / this.rate + 0.9);
      frames = (estimate - (estimate % step) + step) >>> 0;
    }
    return this.formatDescriptor(model, frames, 0x180e8);
  }
  protected formatDescriptor(
    model: BurikoSpeakerModel,
    frames: number,
    flags: number,
  ): BurikoSpeakerDescriptor {
    const waveFormat = new Uint8Array(40),
      view = new DataView(waveFormat.buffer);
    const align = model.frameBytes & 0xffff;
    const masks = [0, 4, 3, 7, 0x33, 0x37, 0x3f, 0x13f, 0x63f];
    view.setUint16(0, 0xfffe, true);
    view.setUint16(2, model.channels, true);
    view.setUint32(4, model.sampleRate, true);
    view.setUint32(8, Math.imul(align, model.sampleRate), true);
    view.setUint16(12, align, true);
    view.setUint16(14, model.bits, true);
    view.setUint16(16, 22, true);
    view.setUint16(18, model.bits, true);
    view.setUint32(20, masks[model.channels] ?? 0, true);
    view.setUint32(24, 1, true);
    view.setUint32(28, 0x100000, true);
    view.setUint32(32, 0xaa000080, true);
    view.setUint32(36, 0x719b3800, true);
    return {waveFormat, flags, frames, byteLength: Math.imul(align, frames) >>> 0};
  }
  async attach(model: BurikoSpeakerModel): Promise<number> {
    if (!this.context.initialized) return this.notReady();
    const prior = await this.detach();
    await prior?.dispose();
    this.model = model;
    const descriptor = this.makeDescriptor(model);
    this.descriptor = descriptor;
    this.buffer = await this.context.backend.create({
      sampleRate: model.sampleRate,
      channels: model.channels,
      bits: model.bits,
      byteLength: descriptor.byteLength,
    });
    this.storage = {
      bytes: new Uint8Array(descriptor.byteLength),
      initialized: new Uint8Array(descriptor.byteLength),
    };
    const setup = this.setup();
    if (setup !== 0) return setup;
    this.attenuation = 128;
    await this.fill();
    this.ready = true;
    return 0;
  }
  /** Actual lock spans, including a zero-length second model call, in native order. */
  protected async readSpans(offset: number, length: number): Promise<number> {
    const model = this.actualModel(),
      storage = this.storage;
    if (storage === null) throw new Error('Buriko speaker lock has no buffer storage');
    if (model.frameBytes === 0) throw new RangeError('Buriko speaker divides by zero PCM width');
    if (offset < 0 || offset >= storage.bytes.length || length < 0 || length > storage.bytes.length)
      throw new RangeError('Buriko speaker lock exceeds actual buffer');
    const first = Math.min(length, storage.bytes.length - offset),
      second = length - first;
    const a = await model.read(storage, offset, Math.floor(first / model.frameBytes));
    const b = await model.read(storage, 0, Math.floor(second / model.frameBytes));
    return (a + b) >>> 0;
  }
  protected async publish(offset: number, length: number): Promise<void> {
    const storage = this.storage;
    if (storage === null) throw new Error('Buriko speaker unlock has no storage');
    const first = Math.min(length, storage.bytes.length - offset);
    const bytes = new Uint8Array(length),
      initialized = new Uint8Array(length);
    bytes.set(storage.bytes.subarray(offset, offset + first));
    initialized.set(storage.initialized.subarray(offset, offset + first));
    bytes.set(storage.bytes.subarray(0, length - first), first);
    initialized.set(storage.initialized.subarray(0, length - first), first);
    await this.actualBuffer().command({kind: 'write', offset, bytes, initialized});
  }
  /** Both actual vtables select1188D0 at+60. */
  protected setup(): number {
    return 0;
  }
  protected async fill(): Promise<void> {
    const model = this.actualModel();
    if (this.context.abi.compatibility === '1.69' && this.legacyAcceleration !== 0) {
      const length = Math.imul(model.frames, model.frameBytes) >>> 0,
        source = {bytes: new Uint8Array(length), initialized: new Uint8Array(length)};
      await model.read(source, 0, model.frames);
      const accelerated = accelerateBurikoLegacy169StaticPcm(
        source,
        model.frames,
        model.sampleRate,
        model.frameBytes,
      );
      if (this.storage === null || accelerated.bytes.length !== this.storage.bytes.length)
        throw new RangeError('Buriko 1.69 accelerated PCM differs from its native descriptor');
      this.storage.bytes.set(accelerated.bytes);
      this.storage.initialized.set(accelerated.initialized);
      // 472970 copies the entire allocation, including any unwritten final-block suffix.
      await this.publish(0, accelerated.bytes.length);
      return;
    }
    if (this.rate === 1) {
      const length = Math.imul(model.frames, model.frameBytes) >>> 0;
      await this.readSpans(0, length);
      await this.publish(0, length);
      return;
    }
    const length = Math.imul(model.frames, model.frameBytes) >>> 0;
    const source = {bytes: new Uint8Array(length), initialized: new Uint8Array(length)};
    await model.read(source, 0, model.frames);
    const scaled = timeScaleBurikoStaticPcm(
      source,
      model.frames,
      model.sampleRate,
      model.channels,
      model.bits,
      this.rate,
    );
    if (this.storage === null || scaled.writtenLength > this.storage.bytes.length)
      throw new RangeError('Buriko scaled fill exceeds actual buffer');
    // Native memmove consumes only the produced prefix.
    if (scaled.initialized.subarray(0, scaled.writtenLength).includes(0))
      throw new Error('Buriko scaled fill reads unwritten PCM');
    this.storage.bytes.set(scaled.bytes.subarray(0, scaled.writtenLength));
    this.storage.initialized.fill(1, 0, scaled.writtenLength);
    await this.publish(0, scaled.writtenLength);
  }
  async setAttenuation(value: number): Promise<number> {
    if (!this.ready) return this.notReady();
    this.attenuation = burikoAudioVolumeDecibels(value | 0);
    await this.actualBuffer().command({kind: 'volume', decibels: this.attenuation});
    return 0;
  }
  async setPan(value: number): Promise<number> {
    if (!this.ready) return this.notReady();
    this.pan = Math.max(-128, Math.min(128, value | 0));
    await this.actualBuffer().command({kind: 'pan', decibels: burikoAudioPanDecibels(this.pan)});
    return 0;
  }
  async start(attenuation: number): Promise<number> {
    if (!this.ready) return this.notReady();
    await this.setAttenuation(attenuation);
    await this.actualBuffer().command({kind: 'play', loop: this.looping()});
    return 0;
  }
  async pause(value: number): Promise<number> {
    if (!this.ready) return this.notReady();
    const buffer = this.actualBuffer(),
      state = await buffer.command({kind: 'status'});
    if (!state.playing && (value | 0) === 0)
      await buffer.command({kind: 'play', loop: this.looping()});
    else if (state.playing && (value | 0) !== 0) await buffer.command({kind: 'stop'});
    return 0;
  }
  async stop(actor?: object): Promise<number> {
    if (!this.ready) return this.notReady();
    const operationActor = actor ?? this.actualModel().captureActor();
    await this.actualBuffer().command({kind: 'stop'});
    await this.actualBuffer().command({kind: 'seek', byteOffset: 0});
    await this.actualModel().reset(operationActor);
    return 0;
  }
  async status(): Promise<number> {
    return (await this.actualBuffer().command({kind: 'status'})).playing ? 1 : 0;
  }
  exchangeRate(value: number): number {
    const previous = this.rate;
    this.rate = value;
    return previous;
  }
  /** 472280 stores only the low byte; this precedes descriptor creation and fill. */
  exchangeLegacyAcceleration(value: number): number {
    const previous = this.legacyAcceleration;
    this.legacyAcceleration = value & 255;
    return previous;
  }
  get frameCount(): number {
    return this.actualModel().frames;
  }
  async detach(): Promise<BurikoSpeakerModel | null> {
    if (this.buffer !== null) {
      await this.buffer.command({kind: 'stop'});
      await this.buffer.dispose();
      this.buffer = null;
    }
    const model = this.model;
    this.model = null;
    this.ready = false;
    this.storage = null;
    return model;
  }
}

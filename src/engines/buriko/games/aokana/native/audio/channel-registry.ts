import {AokanaAudioLevels, aokanaAudioPan} from '../audio-levels.js';
import {AokanaAsyncCriticalSection} from '../async-critical-section.js';
import type {AokanaNativeLocks, AokanaLockActors} from '../exclusion-locks.js';
import type {AokanaSystemTicks} from '../system-ticks.js';
import {AokanaSpeakerContext, AokanaStaticSpeaker} from './speaker.js';
import {AokanaStreamSpeaker} from './stream-speaker.js';
import {AokanaSpeakerModel} from './speaker-model.js';
import {AokanaWaveStream, createAokanaWaveStream} from './wave-stream.js';
import {createAokanaWaveStatic, type AokanaWaveStatic} from './wave-static.js';

export class AokanaAudioChannel {
  active = 0;
  model: AokanaSpeakerModel | null = null;
  readonly levels = new AokanaAudioLevels();
  constructor(readonly speaker: AokanaStaticSpeaker) {
    this.levels.master = this.levels.additional = 128;
    this.levels.volume.current = this.levels.envelope.current = 128;
  }
}
export interface AokanaAudioOutputProfile {
  readonly prefer24Bit: boolean;
  readonly offlineContext?: typeof OfflineAudioContext;
}
/** Actual16/128 vectors and the distinct27CC70 section. No resource/open wrapper substitute. */
export class AokanaAudioChannels {
  readonly stream: AokanaAudioChannel[] = [];
  readonly static: AokanaAudioChannel[] = [];
  readonly streamMaster = new Uint32Array(16);
  readonly staticMaster = new Uint32Array(128);
  /**2745B0: actual separate BSS header records, shared with future F4D50 publication. */
  readonly staticHeaders = new Uint8Array(128 * 64);
  readonly staticHeadersInitialized = new Uint8Array(128 * 64).fill(1);
  readonly section = new AokanaAsyncCriticalSection();
  flags = 0;
  muted = 0;
  window: object | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private timerTail: Promise<void> = Promise.resolve();
  private timerFailure: unknown = null;
  constructor(
    readonly context: AokanaSpeakerContext,
    readonly locks: AokanaNativeLocks,
    readonly actors: AokanaLockActors,
    readonly ticks: AokanaSystemTicks,
    readonly output: AokanaAudioOutputProfile,
  ) {
    this.section.initialize();
  }
  /**114CB0/00DF60; the selected browser backend replaces the native device primitive. */
  initialize(window: object): number {
    if ((this.flags & 1) !== 0) throw new Error('Aokana audio channels already initialized');
    this.flags = 0;
    this.window = window;
    for (let index = 0; index < 16; index++)
      this.stream.push(new AokanaAudioChannel(new AokanaStreamSpeaker(this.context)));
    for (let index = 0; index < 128; index++)
      this.static.push(new AokanaAudioChannel(new AokanaStaticSpeaker(this.context)));
    if (!this.context.initialized) throw new Error('Aokana audio backend initialization failed');
    this.flags |= 1;
    return 0;
  }
  /**114C20: actual20ms host callback; replacing timer1 preserves a single timer. */
  activate(): number {
    if ((this.flags & 1) === 0) return 20;
    this.flags |= 2;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = setInterval(() => {
      void this.dispatchTimer();
    }, 20);
    return 0;
  }
  /**114BD0. */
  deactivate(): number {
    if ((this.flags & 3) !== 3) return 20;
    this.flags &= ~2;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return 0;
  }
  /**111EB0/112210: queued actual callback, one raw tick, NO audio/engine section. */
  dispatchTimer(): Promise<void> {
    const work = this.timerTail.then(async () => {
      this.checkTimer();
      const tick = this.ticks.getTickCount();
      for (const records of [this.stream, this.static])
        for (const channel of records) {
          if (channel.active !== 0 && channel.levels.update(tick))
            await channel.speaker.setAttenuation(channel.levels.attenuation());
        }
    });
    this.timerTail = work.catch((error) => {
      this.timerFailure ??= error;
    });
    return this.timerTail;
  }
  checkTimer(): void {
    if (this.timerFailure !== null) throw this.timerFailure;
  }
  private records(stream: boolean): AokanaAudioChannel[] {
    return stream ? this.stream : this.static;
  }
  private validate(stream: boolean, index: number, active = false): number {
    if ((this.flags & 3) !== 3) return 20;
    const record = this.records(stream)[index >>> 0];
    if (record === undefined) return 21;
    return active && record.active === 0 ? 19 : 0;
  }
  private async internal<T>(actor: object, operation: () => T | Promise<T>): Promise<T> {
    await this.section.enter(actor);
    try {
      return await operation();
    } finally {
      this.section.leave(actor);
    }
  }
  private async engine<T>(actor: object, operation: () => T | Promise<T>): Promise<T> {
    await this.locks.enterEngineAsync(2, actor);
    try {
      return await operation();
    } finally {
      this.locks.leaveEngine(2, actor);
    }
  }
  /**113320/1148E0 through115010/115070. */
  async setMaster(
    stream: boolean,
    index: number,
    value: number,
    actor = this.actors.currentActor,
  ): Promise<number> {
    return this.internal(actor, async () => {
      const status = this.validate(stream, index);
      if (status !== 0) return status;
      const record = this.records(stream)[index >>> 0]!;
      record.levels.master = stream ? value | 0 : Math.min(value >>> 0, 128);
      await record.speaker.setAttenuation(record.levels.attenuation());
      return 0;
    });
  }
  /**F5710/F5780 publish persistent value before engine2 admission. */
  async setPersistentMaster(
    stream: boolean,
    index: number,
    value: number,
    actor = this.actors.currentActor,
  ): Promise<number> {
    index >>>= 0;
    value >>>= 0;
    const masters = stream ? this.streamMaster : this.staticMaster;
    if (index >= masters.length || value > 128) return 0;
    const apply = this.muted === 0;
    masters[index] = value;
    if (apply) await this.engine(actor, () => this.setMaster(stream, index, value, actor));
    return 1;
  }
  /**F5230: recursive engine2 ownership is intentional. */
  async restoreMasters(actor = this.actors.currentActor): Promise<void> {
    await this.engine(actor, async () => {
      for (let index = 0; index < 16; index++)
        await this.setMaster(true, index, this.streamMaster[index]!, actor);
      for (let index = 0; index < 128; index++)
        await this.setMaster(false, index, this.staticMaster[index]!, actor);
    });
  }
  /**F5300 actual persistent-array initializer, distinct from114CB0. */
  async initializeMasters(actor = this.actors.currentActor): Promise<void> {
    await this.engine(actor, async () => {
      this.streamMaster.fill(128);
      this.staticMaster.fill(128);
      await this.restoreMasters(actor);
    });
  }
  /** F52B0 clears the separate 128×64 static header BSS under engine lock 2. */
  async clearStaticHeaders(actor = this.actors.currentActor): Promise<void> {
    await this.engine(actor, () => {
      this.staticHeaders.fill(0);
      this.staticHeadersInitialized.fill(1);
    });
  }
  async mute(actor = this.actors.currentActor): Promise<void> {
    await this.engine(actor, async () => {
      if (this.muted !== 0) return;
      this.muted = 1;
      for (let index = 0; index < 16; index++) await this.setMaster(true, index, 0, actor);
      for (let index = 0; index < 128; index++) await this.setMaster(false, index, 0, actor);
    });
  }
  async unmute(actor = this.actors.currentActor): Promise<void> {
    await this.engine(actor, async () => {
      if (this.muted === 0) return;
      await this.restoreMasters(actor);
      this.muted = 0;
    });
  }
  /**1140A0 concrete existing WaveBox producer and its complete channel publication. */
  async attachStream(
    index: number,
    bytes: Uint8Array,
    volume: number,
    pan: number,
    gain: number,
    loopFlags = 0,
  ): Promise<number> {
    const record = this.stream[index >>> 0];
    if (record === undefined) throw new RangeError('Aokana raw stream attachment exceeds registry');
    const wave = await createAokanaWaveStream(
      bytes,
      {gain, prefer24Bit: this.output.prefer24Bit},
      () => this.ticks.getTickCount(),
      this.output.offlineContext,
    );
    const status = await this.publishInitializedStream(index, wave, volume, pan, loopFlags);
    if (status !== 0) throw new Error('Aokana stream speaker attachment failed:22');
    return 0;
  }
  /**1140A0 after successful model initialization; publication precedes speaker attachment. */
  async publishInitializedStream(
    index: number,
    wave: AokanaWaveStream,
    volume: number,
    pan: number,
    loopFlags = 0,
  ): Promise<number> {
    const record = this.stream[index >>> 0];
    if (record === undefined)
      throw new RangeError('Aokana raw stream publication exceeds registry');
    if ((loopFlags & 1) !== 0) wave.decoder.overrideLoop(loopFlags & 2);
    const previous = await record.speaker.detach();
    await previous?.dispose();
    const model = new AokanaSpeakerModel(wave);
    record.model = model;
    const status = await record.speaker.attach(model);
    if (status !== 0) return 22;
    record.levels.volume.active = false;
    record.levels.volume.current = 128;
    record.levels.volume.current = volume | 0;
    record.levels.envelope.active = false;
    record.levels.envelope.current = 128;
    record.active = 1;
    await record.speaker.setAttenuation(record.levels.attenuation());
    await this.setPanRaw(true, index, pan);
    return 0;
  }
  /**112020: static model fade-in precedes detachment; speed precedes attach. */
  async attachStatic(
    index: number,
    bytes: Uint8Array,
    fadeMilliseconds: number,
    gain: number,
    speed: number,
  ): Promise<number> {
    const record = this.static[index >>> 0];
    if (record === undefined) throw new RangeError('Aokana raw static attachment exceeds registry');
    const wave = await createAokanaWaveStatic(
      bytes,
      {gain, prefer24Bit: this.output.prefer24Bit},
      this.output.offlineContext,
    );
    return this.publishInitializedStatic(index, wave, fadeMilliseconds, speed);
  }
  /**111ED0 after initialization, before fade/detach/rate/publication. */
  async publishInitializedStatic(
    index: number,
    wave: AokanaWaveStatic,
    fadeMilliseconds: number,
    speed: number,
  ): Promise<number> {
    const record = this.static[index >>> 0];
    if (record === undefined) throw new RangeError('Aokana static publication exceeds registry');
    wave.fadeIn(fadeMilliseconds);
    const previous = await record.speaker.detach();
    await previous?.dispose();
    record.speaker.exchangeRate(speed);
    const model = new AokanaSpeakerModel(wave);
    record.model = model;
    const status = await record.speaker.attach(model);
    if (status !== 0) return 22;
    record.levels.volume.active = false;
    record.levels.volume.current = 128;
    record.levels.envelope.active = false;
    record.levels.envelope.current = 128;
    record.active = 1;
    await record.speaker.setAttenuation(record.levels.attenuation());
    return 0;
  }
  /**113200/1147D0 already run inside their caller's section, when any. */
  async setPanRaw(stream: boolean, index: number, value: number): Promise<number> {
    const status = this.validate(stream, index, true);
    if (status !== 0) return status;
    const pan = stream ? aokanaAudioPan(value) : ((value - 64) | 0) * 2;
    const integer = Math.trunc(pan);
    const converted = integer < -2147483648 || integer > 2147483647 ? -2147483648 : integer;
    await this.records(stream)[index >>> 0]!.speaker.setPan(converted);
    return 0;
  }
  /**1133C0/115590. */
  async fadeStream(
    index: number,
    target: number,
    duration: number,
    actor = this.actors.currentActor,
  ): Promise<number> {
    return this.internal(actor, () => {
      const status = this.validate(true, index, true);
      if (status !== 0) return status;
      this.stream[index >>> 0]!.levels.volume.begin(
        this.ticks.getTickCount(),
        duration,
        Math.min(target >>> 0, 128),
      );
      return 0;
    });
  }
  /**114990/1150D0: pan, level, envelope reset, speaker stop, then start. */
  async startStatic(
    index: number,
    volume: number,
    pan: number,
    actor = this.actors.currentActor,
  ): Promise<number> {
    return this.internal(actor, async () => {
      const status = this.validate(false, index, true);
      if (status !== 0) return status;
      await this.setPanRaw(false, index, pan);
      const record = this.static[index >>> 0]!;
      record.levels.volume.current = volume | 0;
      record.levels.envelope.active = false;
      record.levels.envelope.current = 128;
      await record.speaker.stop(actor);
      return (await record.speaker.start(record.levels.attenuation())) === 0 ? 0 : 23;
    });
  }
  /** Direct-control wrappers own engine2 outside the distinct channel section. */
  async withEngineControl<T>(
    operation: (actor: object) => T | Promise<T>,
    actor = this.actors.currentActor,
  ): Promise<T> {
    return this.engine(actor, () => operation(actor));
  }
  /**115780/113460: preserve the actual streaming virtual pause implementation. */
  async pauseStream(
    index: number,
    value: number,
    actor = this.actors.currentActor,
  ): Promise<number> {
    return this.internal(actor, async () => {
      const status = this.validate(true, index, true);
      if (status !== 0) return status;
      await this.stream[index >>> 0]!.speaker.pause(value);
      return 0;
    });
  }
  /**115660/113200. */
  async panStream(index: number, value: number, actor = this.actors.currentActor): Promise<number> {
    return this.internal(actor, () => this.setPanRaw(true, index, value));
  }
  /**113530/1135C0/1134A0: envelope changes publish only through the actual timer. */
  async fadeEnvelope(
    stream: boolean,
    index: number,
    target: 0 | 128,
    duration: number,
    actor = this.actors.currentActor,
  ): Promise<number> {
    return this.internal(actor, () => {
      const status = this.validate(stream, index, true);
      if (status !== 0) return status;
      this.records(stream)[index >>> 0]!.levels.envelope.begin(
        this.ticks.getTickCount(),
        duration,
        target,
      );
      return 0;
    });
  }
  /**113270/114830 intentionally publish attenuation without requiring active records. */
  async setAdditional(
    stream: boolean,
    index: number,
    value: number,
    actor = this.actors.currentActor,
  ): Promise<number> {
    return this.internal(actor, async () => {
      const status = this.validate(stream, index);
      if (status !== 0) return status;
      const record = this.records(stream)[index >>> 0]!;
      record.levels.additional = Math.min(value >>> 0, 128);
      await record.speaker.setAttenuation(record.levels.attenuation());
      return 0;
    });
  }
  /**114EB0/113140: actual stream stop/reset under the existing channel section. */
  async stopStream(index: number, actor = this.actors.currentActor): Promise<number> {
    return this.internal(actor, async () => {
      const status = this.validate(true, index, true);
      if (status !== 0) return status;
      await this.stream[index >>> 0]!.speaker.stop(actor);
      return 0;
    });
  }
  /**F5800/115230/114790: ignore the valid speaker's stop result. */
  async stopStatic(index: number, actor = this.actors.currentActor): Promise<number> {
    return this.internal(actor, async () => {
      const status = this.validate(false, index, true);
      if (status !== 0) return status;
      await this.static[index >>> 0]!.speaker.stop(actor);
      return 0;
    });
  }
  /**F5D10 preserves separate status and optional-loop section acquisitions. */
  async streamStatus(
    index: number,
    publishLoop: ((value: number) => void) | null,
    operationActor = this.actors.currentActor,
  ): Promise<number> {
    index >>>= 0;
    if (index >= 16) return 0;
    return this.withEngineControl(async (actor) => {
      let playing = 0;
      await this.internal(actor, async () => {
        if (this.validate(true, index, true) === 0)
          playing = await this.stream[index >>> 0]!.speaker.status();
      });
      if (publishLoop !== null)
        await this.internal(actor, () => {
          if (this.validate(true, index, true) !== 0) return;
          const wave = this.stream[index >>> 0]!.model?.wave;
          if (!(wave instanceof AokanaWaveStream))
            throw new Error('Aokana stream query consumes an absent native WaveBox');
          publishLoop(wave.visibleLoopCount);
        });
      return playing;
    }, operationActor);
  }
  /**F5E20 clears all64 header bytes before section admission and real static detachment. */
  async releaseStatic(index: number, operationActor = this.actors.currentActor): Promise<number> {
    return this.withEngineControl(async (actor) => {
      const offset = (index >>> 0) * 64;
      if (offset + 64 > this.staticHeaders.length)
        throw new RangeError('Aokana static header release exceeds its native array');
      this.staticHeaders.fill(0, offset, offset + 64);
      this.staticHeadersInitialized.fill(1, offset, offset + 64);
      return this.internal(actor, () => this.detach(false, index));
    }, operationActor);
  }
  /**113090/1146E0 raw lower, with exact activation check before model destruction. */
  async detach(stream: boolean, index: number): Promise<number> {
    const status = this.validate(stream, index);
    if (status !== 0) return status;
    const record = this.records(stream)[index >>> 0]!;
    await (await record.speaker.detach())?.dispose();
    record.model = null;
    record.active = 0;
    return 0;
  }
  /** Channel-vector portion of112E90 plus real speaker destructor ownership.
   * The separate static-resource cache tree is not claimed by this owner. */
  async disposeChannels(): Promise<void> {
    if ((this.flags & 1) === 0) return;
    this.deactivate();
    await this.timerTail;
    for (const [stream, records] of [
      [true, this.stream],
      [false, this.static],
    ] as const) {
      for (let index = 0; index < records.length; index++) {
        await this.detach(stream, index); // Native activation check now returns20.
        await (await records[index]!.speaker.detach())?.dispose();
      }
      records.length = 0;
    }
    this.flags = 0;
  }
}

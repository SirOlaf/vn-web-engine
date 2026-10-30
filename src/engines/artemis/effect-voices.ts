import type {AudioVoice} from '../../audio/transport.js';
import {artemisRevision} from './revision.js';
import {artemisSoundGain, artemisSoundAttenuation, artemisSoundBalance} from './audio-gain.js';
import {ArtemisLinearIntegerTween} from './integer-tween.js';

export interface ArtemisEffectVoiceHost {
  /** Actual decoded, paused PCM/device voice. Null is an ordinary native load failure. */
  prepareVoice(file: string, bufferMode: number): Promise<AudioVoice | null>;
}
interface Effect {
  readonly voice: AudioVoice;
  readonly gains: Map<number, number>;
  readonly jobs: Map<number, ArtemisLinearIntegerTween>;
  pan: number;
  playing: boolean;
  startTick: number;
  onFinish?: () => void;
}
function int32(value: number): void {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff)
    throw Error('Unsupported Artemis int32 audio parameter');
}
/** Native sound-manager ownership and default integer fade tasks. Requires actual
 * voices and real scheduler ticks. It does not create a silent/timer substitute.
 * Different manager instances share the native preparation-time inactive cleanup. */
export class ArtemisEffectVoices {
  private static readonly managers = new Set<ArtemisEffectVoices>();
  private readonly effects = new Map<number, Effect>();
  private next = 1;
  private closed = false;
  private pending = false;
  private groupGain = 1000;
  private suppressGain = false;
  private clock = 0;
  constructor(
    private readonly hash: string,
    private readonly host: ArtemisEffectVoiceHost,
  ) {
    artemisRevision(hash);
    ArtemisEffectVoices.managers.add(this);
  }
  private open(): void {
    if (this.closed) throw Error('Artemis effect voices closed');
  }
  private cancel(effect: Effect, key: number): void {
    effect.jobs.get(key)?.cancel();
    effect.jobs.delete(key);
  }
  private project(effect: Effect): void {
    if (this.suppressGain) return;
    const gain = artemisSoundGain(this.hash, this.groupGain, effect.gains),
      attenuation = artemisSoundAttenuation(this.hash, gain);
    effect.voice.volume(10 ** (attenuation / 2000));
  }
  private assignGain(effect: Effect, key: number, gain: number): void {
    effect.gains.set(key, gain);
    this.project(effect);
  }
  private retire(index: number, effect: Effect): void {
    this.effects.delete(index);
    for (const job of effect.jobs.values()) job.cancel();
    effect.jobs.clear();
    effect.voice.dispose();
  }
  private collectInactive(): void {
    for (const [index, effect] of this.effects) if (!effect.playing) this.retire(index, effect);
  }
  get count(): number {
    return this.effects.size;
  }
  isPlaying(index: number): boolean {
    const effect = this.effects.get(index);
    return !!effect?.playing;
  }
  /** CSoundPlayer +0x44, getter virtual +0x38; Stop clears it with the state word. */
  startTick(index: number): number {
    return this.effects.get(index)?.startTick ?? 0;
  }
  /** ae2e0/ae440 assign/clear the existing player's callback; missing indices do nothing. */
  setFinishCallback(index: number, callback: (() => void) | null): void {
    this.open();
    const effect = this.effects.get(index);
    if (effect) effect.onFinish = callback ?? undefined;
  }
  async prepareEffect(file: string, bufferMode: number): Promise<number> {
    this.open();
    int32(bufferMode);
    if (this.pending) throw Error('Overlapping Artemis voice preparation');
    for (const manager of ArtemisEffectVoices.managers) manager.collectInactive();
    this.pending = true;
    try {
      const voice = await this.host.prepareVoice(file, bufferMode);
      if (!voice) {
        this.open();
        return 0;
      }
      try {
        this.open();
        if (!voice.setLoop || !voice.stop)
          throw Error('Artemis voice requires loop and reset controls');
        if (this.next > 0xffffffff) throw Error('Artemis sound index overflow');
        voice.volume(1); // Native fresh CSoundPlayer gain defaults to1000.
        const index = this.next++;
        this.effects.set(index, {
          voice,
          gains: new Map(),
          jobs: new Map(),
          pan: 0,
          playing: false,
          startTick: 0,
        });
        return index;
      } catch (error) {
        voice.dispose();
        throw error;
      }
    } finally {
      this.pending = false;
    }
  }
  discardPreparedEffect(index: number): void {
    const effect = this.effects.get(index);
    if (effect) this.retire(index, effect);
  }
  setGroupGain(gain: number): void {
    this.open();
    int32(gain);
    this.groupGain = gain;
    for (const effect of this.effects.values()) this.project(effect);
  }
  /** Native manager+60 suppresses volume projection, rather than inventing mute. */
  suppressGainUpdates(suppressed: boolean): void {
    this.open();
    this.suppressGain = suppressed;
  }
  /** add70: the player's gain for `scope`; a missing player reads -1, an unset scope 1000. */
  effectGain(index: number, scope: number): number {
    this.open();
    int32(scope);
    const effect = this.effects.get(index);
    if (!effect) return -1;
    return effect.gains.get(scope) ?? 1000;
  }
  setEffectGain(index: number, scope: number, gain: number, milliseconds = 0): void {
    this.open();
    int32(scope);
    int32(gain);
    int32(milliseconds);
    const effect = this.effects.get(index);
    if (!effect) return;
    this.cancel(effect, scope);
    if (milliseconds === 0) this.assignGain(effect, scope, gain);
    else
      effect.jobs.set(
        scope,
        new ArtemisLinearIntegerTween(
          this.hash,
          effect.gains.get(scope) ?? 1000,
          gain,
          milliseconds,
          (value) => this.assignGain(effect, scope, value),
        ),
      );
  }
  setEffectPan(index: number, pan: number, milliseconds: number): void {
    this.open();
    int32(pan);
    int32(milliseconds);
    const effect = this.effects.get(index);
    if (!effect) return;
    this.cancel(effect, -2);
    const apply = (value: number) => {
      const balance = artemisSoundBalance(this.hash, value);
      if (!effect.voice.stereoBalance)
        throw Error('Artemis voice requires stereo balance controls');
      effect.voice.stereoBalance(balance.left, balance.right);
      effect.pan = value;
    };
    if (milliseconds === 0) apply(pan);
    else
      effect.jobs.set(
        -2,
        new ArtemisLinearIntegerTween(this.hash, effect.pan, pan, milliseconds, apply),
      );
  }
  startEffect(index: number, milliseconds: number, loop: boolean): void {
    this.open();
    int32(milliseconds);
    if (typeof loop !== 'boolean') throw Error('Invalid Artemis sound loop mode');
    const effect = this.effects.get(index);
    if (!effect) return;
    this.cancel(effect, -1);
    if (milliseconds === 0) this.project(effect);
    else {
      this.assignGain(effect, -1, 0);
      effect.jobs.set(
        -1,
        new ArtemisLinearIntegerTween(this.hash, 0, 1000, milliseconds, (value) =>
          this.assignGain(effect, -1, value),
        ),
      );
    }
    // Native164410 does nothing if its playing flag is already set. A stopped
    // player can be reused, starting at its reset device cursor.
    if (!effect.playing) {
      if (effect.voice.ended()) effect.voice.stop!();
      effect.voice.setLoop!(loop);
      effect.voice.pause(false);
      effect.startTick = this.clock;
    }
    effect.playing = true;
  }
  stopEffect(index: number, milliseconds: number): void {
    this.open();
    int32(milliseconds);
    const effect = this.effects.get(index);
    if (!effect) return;
    this.cancel(effect, -1);
    if (milliseconds === 0) this.retire(index, effect);
    else
      effect.jobs.set(
        -1,
        new ArtemisLinearIntegerTween(
          this.hash,
          effect.gains.get(-1) ?? 1000,
          0,
          milliseconds,
          (value) => this.assignGain(effect, -1, value),
          () => {
            effect.voice.stop!();
            effect.playing = false;
            effect.startTick = 0;
          },
        ),
      );
  }
  /** Called by the engine scheduler with its actual uint32 clock. */
  tick(now: number): void {
    this.open();
    if (!Number.isInteger(now) || now < 0 || now > 0xffffffff)
      throw Error('Invalid Artemis audio clock');
    this.clock = now;
    for (const effect of [...this.effects.values()]) {
      if (!effect.playing) continue;
      effect.voice.pump?.();
      if (effect.voice.ended()) {
        effect.voice.stop!();
        effect.playing = false;
        effect.startTick = 0;
        effect.onFinish?.();
      }
    }
    for (const effect of [...this.effects.values()])
      for (const [key, job] of [...effect.jobs])
        if (effect.jobs.get(key) === job && job.tick(now)) effect.jobs.delete(key);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [index, effect] of [...this.effects]) this.retire(index, effect);
    ArtemisEffectVoices.managers.delete(this);
  }
}

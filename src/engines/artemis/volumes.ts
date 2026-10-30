import type {ArtemisVariables} from './variables.js';
import {artemisInteger} from './numbers.js';

export interface ArtemisVolumesHost {
  /** Script +0x3d88: effect id to sound index, in map order. */
  readonly effectSlots: Map<string, number>;
  /** Music (+0x3d60) and effect (+0x3d78) manager group gains (+0x5c). */
  applyGroupVolumes(music: number, effect: number): void;
  /** 0x1400adcf0: the effect player's state is nonzero. */
  effectPlaying(index: number): boolean;
  /** 0x1400add70: the effect player's gain for `scope`. */
  effectGain(index: number, scope: 1): number;
  /** 0x1400adf30 (index, scope, gain, time). */
  setEffectGain(index: number, scope: 1, gain: number, milliseconds: number): void;
}

/** `s.segain.<id>` through the variable object's integer getter (virtual +0x10). */
export function artemisEffectGainVariable(
  variables: ArtemisVariables,
  id: string,
): number | undefined {
  const value = variables.lookup('s.segain.' + id);
  if (value === undefined) return undefined;
  const gain = Number(new TextDecoder().decode(value));
  if (!Number.isInteger(gain) || gain < -0x80000000 || gain > 0x7fffffff)
    throw Error('Unsupported Artemis sound gain variable');
  return gain;
}

/** 0x1400c4680, run by the engine reset (bf210, with the values it read) and in every frame
 * (c0560, after `onEnterFrame`). `s.bgmvol`/`s.sevol` (absent: 0) reach the music and effect
 * managers when they differ from the values applied last. Each id of the effect map whose
 * player is playing then takes `s.segain.<id>` (scope 1, immediately) when the variable
 * exists and differs from the player's gain; ids without a playing player leave the map. */
export class ArtemisVolumes {
  private applied: readonly [number, number] | null = null;
  constructor(
    private readonly variables: ArtemisVariables,
    private readonly host: ArtemisVolumesHost,
  ) {}
  private integer(name: string): number {
    const value = this.variables.lookup(name);
    return value === undefined ? 0 : artemisInteger(new TextDecoder().decode(value));
  }
  /** The reset's managers are new, so its group volumes always apply. */
  applyAfterReset(music: number, effect: number): void {
    this.applyGroup(music, effect);
    this.applyEffectGains();
  }
  apply(): void {
    const music = this.integer('s.bgmvol'),
      effect = this.integer('s.sevol');
    if (!this.applied || this.applied[0] !== music || this.applied[1] !== effect)
      this.applyGroup(music, effect);
    this.applyEffectGains();
  }
  private applyGroup(music: number, effect: number): void {
    this.applied = [music, effect];
    this.host.applyGroupVolumes(music, effect);
  }
  private applyEffectGains(): void {
    const slots = this.host.effectSlots;
    for (const [id, index] of slots) {
      if (!this.host.effectPlaying(index)) {
        slots.delete(id);
        continue;
      }
      const gain = artemisEffectGainVariable(this.variables, id);
      if (gain !== undefined && this.host.effectGain(index, 1) !== gain)
        this.host.setEffectGain(index, 1, gain, 0);
    }
  }
}

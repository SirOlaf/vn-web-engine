import type {AsbTag} from '../../formats/artemis/asb.js';
import {artemisInteger} from './numbers.js';
import {artemisRevision} from './revision.js';

export interface ArtemisSeAdjustHost {
  /** Script +0x3d88 exact named SE id to sound index. */
  effectIndex(id: string): number | undefined;
  /** Sound manager 0x1400adf30 (index, scope, gain, time). */
  setEffectGain(index: number, scope: 0, gain: number, milliseconds: number): void;
  /** Sound manager 0x1400ae110 (index, pan, time). */
  setEffectPan(index: number, pan: number, milliseconds: number): void;
  /** Save object +0x78 operator[](id): the block's `key` argument becomes `value`. */
  setEffectHistoryArgument(id: string, key: string, value: string): void;
}

/** `sefade` (0x1400e3ee0) and `sepan` (0x1400e4220). A known id moves its voice gain (scope
 * 0) or pan to `gain`/`pan` over `time` (absent: 0). `gain`/`pan` come from operator[], so
 * an absent value reads as 0. Outside replay the value is copied into the id's save-object
 * block, which operator[] creates (as an empty block) for an id without history, even when
 * the id has no sound. */
export class ArtemisSeAdjust {
  constructor(
    hash: string,
    private readonly host: ArtemisSeAdjustHost,
  ) {
    artemisRevision(hash);
  }
  dispatch(input: AsbTag, recordHistory = true): boolean {
    const key = input.name === 'sefade' ? 'gain' : input.name === 'sepan' ? 'pan' : null;
    if (!key) return false;
    const args = new Map(input.args);
    if (!args.has('id')) args.set('id', '');
    const id = args.get('id')!,
      index = this.host.effectIndex(id);
    if (index !== undefined) {
      if (!Number.isInteger(index) || index < 0 || index > 0xffffffff)
        throw Error('Unsupported Artemis sound index');
      const time = args.has('time') ? artemisInteger(args.get('time')!) : 0;
      if (!args.has(key)) args.set(key, '');
      const value = artemisInteger(args.get(key)!);
      if (key === 'gain') this.host.setEffectGain(index, 0, value, time);
      else this.host.setEffectPan(index, value, time);
    }
    if (recordHistory) {
      if (!args.has(key)) args.set(key, '');
      this.host.setEffectHistoryArgument(id, key, args.get(key)!);
    }
    return true;
  }
}

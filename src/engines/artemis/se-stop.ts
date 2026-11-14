import type {AsbTag} from '../../formats/artemis/asb.js';
import {artemisInteger} from './numbers.js';
import {artemisRevision} from './revision.js';

export interface ArtemisSeStopHost {
  /** Script3d88 exact named SE-id to unsigned sound-index table. */
  effectIndex(id: string): number | undefined;
  /** Actual audio manager0ad9a0: immediate stop at0, otherwise schedule fade-out. */
  stopEffect(index: number, milliseconds: number): void;
  hasEffectHistory(id: string): boolean;
  deleteEffectHistory(id: string): void;
}
/** e3c60 handles both sestop/sefadeout. A missing slot performs no audio work and
 * does not parse time. Normal execution removes existing replay history even when
 * the sound is absent; replay leaves history unchanged. Playback requires its own
 * actual loader/voice owner and is intentionally outside this command contract.
 */
export class ArtemisSeStop {
  constructor(
    hash: string,
    private readonly host: ArtemisSeStopHost,
  ) {
    artemisRevision(hash);
  }
  dispatch(input: AsbTag, recordHistory = true): boolean {
    if (input.name !== 'sestop' && input.name !== 'sefadeout') return false;
    const tag = {...input, args: new Map(input.args)},
      id = tag.args.get('id') ?? '',
      index = this.host.effectIndex(id);
    if (index !== undefined) {
      if (!Number.isInteger(index) || index < 0 || index > 0xffffffff)
        throw Error('Unsupported Artemis sound index');
      const time = tag.args.has('time') ? artemisInteger(tag.args.get('time')!) : 0;
      this.host.stopEffect(index, time);
    }
    if (recordHistory && this.host.hasEffectHistory(id)) this.host.deleteEffectHistory(id);
    return true;
  }
}

import type {AsbTag} from '../../formats/artemis/asb.js';
import {artemisInteger} from './numbers.js';
import {artemisRevision} from './revision.js';

export interface ArtemisSePlayHost {
  debugSkipActive(): boolean;
  /** skipAllowed&&(commandSkip||controlSkip), independently of debugSkip. */
  commandSkipActive(): boolean;
  effectIndex(id: string): number | undefined;
  stopEffect(index: number, milliseconds: number): void;
  /** Actual loader190920;0 means native load failure. Loaded sounds are not yet started. */
  prepareEffect(file: string, bufferMode: number): Promise<number>;
  discardPreparedEffect(index: number): void;
  setEffectIndex(id: string, index: number): void;
  setEffectGain(index: number, scope: 0 | 1, gain: number, milliseconds?: number): void;
  setEffectPan(index: number, pan: number, milliseconds: number): void;
  effectGainVariable(id: string): number | undefined;
  startEffect(index: number, milliseconds: number, loop: boolean): void;
  /** Non-loop playback replaces history with the native empty block. */
  replaceEffectHistory(id: string, tag: AsbTag | null): void;
  effectLoadFailed(tag: AsbTag): void;
}
function index(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
    throw Error('Unsupported Artemis sound index');
}
/** e3370 seplay/sefadein. Parsing, replacement, skip, variable gain and replay
 * history follow native order. A real prepared-sound/voice service is mandatory;
 * decoding alone cannot satisfy startEffect. */
export class ArtemisSePlay {
  private closed = false;
  private pending = false;
  private generation = 0;
  constructor(
    hash: string,
    private readonly host: ArtemisSePlayHost,
  ) {
    artemisRevision(hash);
  }
  cancelPending(): void {
    this.generation++;
    this.pending = false;
  }
  close(): void {
    this.closed = true;
    this.cancelPending();
  }
  async dispatch(input: AsbTag, recordHistory = true): Promise<boolean> {
    if (input.name !== 'seplay' && input.name !== 'sefadein') return false;
    if (this.closed) throw Error('Artemis SE playback closed');
    if (this.pending) throw Error('Overlapping Artemis SE preparation');
    const tag = {...input, args: new Map(input.args)},
      loop = tag.args.has('loop') && tag.args.get('loop') !== '0';
    let id = tag.args.get('id') ?? '';
    if (!this.host.debugSkipActive()) {
      if (!tag.args.has('id')) tag.args.set('id', '');
      const old = this.host.effectIndex(id);
      if (old !== undefined) {
        index(old);
        this.host.stopEffect(old, 0);
      }
      if (
        tag.args.has('skippable') &&
        artemisInteger(tag.args.get('skippable')!) !== 0 &&
        (this.host.commandSkipActive() || this.host.debugSkipActive())
      )
        return true;
      const buffer = tag.args.has('buffer') ? artemisInteger(tag.args.get('buffer')!) : 0;
      if (!tag.args.has('file')) tag.args.set('file', '');
      this.pending = true;
      const generation = this.generation;
      try {
        const prepared = await this.host.prepareEffect(tag.args.get('file')!, buffer);
        index(prepared);
        if (this.closed || generation !== this.generation) {
          if (prepared) this.host.discardPreparedEffect(prepared);
          throw Error('Artemis SE preparation cancelled');
        }
        if (!prepared) {
          this.host.effectLoadFailed(tag);
          return true;
        }
        this.host.setEffectIndex(id, prepared);
        if (tag.args.has('gain'))
          this.host.setEffectGain(prepared, 0, artemisInteger(tag.args.get('gain')!));
        if (tag.args.has('pan'))
          this.host.setEffectPan(prepared, artemisInteger(tag.args.get('pan')!), 0);
        const gain = this.host.effectGainVariable(id);
        if (gain !== undefined) {
          if (!Number.isInteger(gain) || gain < -0x80000000 || gain > 0x7fffffff)
            throw Error('Unsupported Artemis sound gain variable');
          this.host.setEffectGain(prepared, 1, gain);
        }
        const time = tag.args.has('time') ? artemisInteger(tag.args.get('time')!) : 0;
        this.host.startEffect(prepared, time, loop);
      } finally {
        if (generation === this.generation) this.pending = false;
      }
    }
    if (recordHistory) {
      if (!tag.args.has('id')) tag.args.set('id', '');
      id = tag.args.get('id')!;
      this.host.replaceEffectHistory(id, loop ? tag : null);
    }
    return true;
  }
}

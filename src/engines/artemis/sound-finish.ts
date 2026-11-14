import type {AsbTag} from '../../formats/artemis/asb.js';
import {captureEventCommand} from './event-commands.js';
import {artemisRevision} from './revision.js';

export interface ArtemisSoundFinishHost {
  currentFile(): string;
  /** Absence of the id argument selects music; a present empty id selects SE. */
  musicIndex(): number;
  effectIndex(id: string): number | undefined;
  setMusicFinish(index: number, callback: (() => void) | null): void;
  setEffectFinish(index: number, callback: (() => void) | null): void;
  /** The native handler dispatcher owns execution of this captured registration. */
  emit(command: AsbTag): void;
}
export class ArtemisSoundFinish {
  constructor(
    hash: string,
    private readonly host: ArtemisSoundFinishHost,
  ) {
    artemisRevision(hash);
  }
  dispatch(tag: AsbTag): boolean {
    if (tag.name !== 'setonsoundfinish' && tag.name !== 'delonsoundfinish') return false;
    const registration =
      tag.name === 'setonsoundfinish'
        ? captureEventCommand(tag, () => this.host.currentFile())
        : null;
    const effect = tag.args.has('id'),
      index = effect ? this.host.effectIndex(tag.args.get('id')!) : this.host.musicIndex();
    if (index === undefined) return true;
    if (!Number.isInteger(index) || index < 0 || index > 0xffffffff)
      throw Error('Unsupported Artemis sound callback index');
    const callback = registration
      ? () => this.host.emit({...registration, args: new Map(registration.args)})
      : null;
    if (effect) this.host.setEffectFinish(index, callback);
    else this.host.setMusicFinish(index, callback);
    return true;
  }
}

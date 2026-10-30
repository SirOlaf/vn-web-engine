import type {AsbTag} from '../../formats/artemis/asb.js';
import {artemisRevision} from './revision.js';

export interface ArtemisTextCommandHost {
  currentMessageLayer(): string;
  newline(layer: string, omitBlankLine: boolean): void;
  backlogAllowed(): boolean;
  backlogIncludeFont(): boolean;
  /** Copies the actual selected resource, history and annotation into backlog. */
  captureBacklog(layer: string, includeFont: boolean): void;
  clearCommandHistory(layer: string): void;
  saveCurrentFontHistory(layer: string): void;
  /** Move pending prohibit/indent replay slots to their retained slots and clear pending. */
  promoteRememberedTextCommands(layer: string): void;
  /** Native skipAllowed&&(commandSkip||controlSkip), or debugSkip != 0. */
  forceImmediateClear(): boolean;
  /** Must perform actual native clear, including cancel/release/outgoing jobs and links. */
  clearText(layer: string, useOutgoingDescriptors: boolean): Promise<void>;
  recordTextCommand(layer: string, tag: AsbTag): void;
}
/** cccb0 rt/cce40 rp. History maintenance happens before the mandatory resource
 * clear. Replay skips history/backlog effects but still clears the actual layer.
 */
export class ArtemisTextCommands {
  private pending = false;
  private closed = false;
  private generation = 0;
  constructor(
    hash: string,
    private readonly host: ArtemisTextCommandHost,
  ) {
    artemisRevision(hash);
  }
  close(): void {
    this.closed = true;
    this.generation++;
    this.pending = false;
  }
  async dispatch(input: AsbTag, recordHistory = true): Promise<boolean> {
    if (!['rt', 'rp'].includes(input.name)) return false;
    if (this.closed) throw Error('Artemis text commands closed');
    if (this.pending) throw Error('Overlapping Artemis text commands');
    const tag = {...input, args: new Map(input.args)},
      layer = this.host.currentMessageLayer();
    if (tag.name === 'rt') {
      this.host.newline(
        layer,
        tag.args.has('omitblankline') && tag.args.get('omitblankline') !== '0',
      );
      if (recordHistory) this.host.recordTextCommand(layer, tag);
      return true;
    }
    this.pending = true;
    const generation = this.generation;
    try {
      if (recordHistory) {
        const backlog = tag.args.has('backlog')
          ? tag.args.get('backlog') !== '0'
          : this.host.backlogAllowed();
        if (backlog) this.host.captureBacklog(layer, this.host.backlogIncludeFont());
        this.host.clearCommandHistory(layer);
        this.host.saveCurrentFontHistory(layer);
        this.host.promoteRememberedTextCommands(layer);
      }
      await this.host.clearText(layer, !this.host.forceImmediateClear());
      if (this.closed || generation !== this.generation)
        throw Error('Artemis text clear cancelled');
      return true;
    } finally {
      if (generation === this.generation) this.pending = false;
    }
  }
}

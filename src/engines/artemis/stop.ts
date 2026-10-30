import type {AsbTag} from '../../formats/artemis/asb.js';
import type {ArtemisModes} from './modes.js';
import type {ArtemisSave} from './save.js';

export interface ArtemisStopHost {
  /** Script field +0x3520. */
  debugSkipActive(): boolean;
  /** Current text layer (stage +0xa0) virtual +0x1c8(vector, 1): the skip vector +0x3718
   * when skipping or debug-skipping, otherwise the current message layer's `in` vector
   * (+0x3730 map at +0x35e0), as in the wait tag 0x1400cc0c0. */
  startTextDisplay(skip: boolean): void;
  /** Unless run mode is 13: previous mode c74 = mode, mode c70 = 3 and scheduler +0x30(0).
   * Returns false when mode 13 refused the change. */
  enterStopMode(): boolean;
}

/** Native stop tag 0x1400c7bb0. The mode 3 entry is open-coded with the same save gate
 * as 0x1400c6160 mode 3; an active automode is then switched off without force (b7810). */
export class ArtemisStop {
  constructor(
    private readonly modes: ArtemisModes,
    private readonly save: ArtemisSave,
    private readonly host: ArtemisStopHost,
  ) {}
  dispatch(tag: AsbTag): boolean {
    if (tag.name !== 'stop') return false;
    const skip =
      (this.modes.skipAllowed && (this.modes.commandSkip || this.modes.controlSkip)) ||
      this.host.debugSkipActive();
    this.host.startTextDisplay(skip);
    if (this.host.enterStopMode() && !skip)
      this.save.request(this.modes.autosave === 2 ? 'autosave.dat' : '');
    if (this.modes.automode) this.modes.setAutomode(false);
    return true;
  }
}

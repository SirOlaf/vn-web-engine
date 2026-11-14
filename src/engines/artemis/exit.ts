import type {AsbTag} from '../../formats/artemis/asb.js';
import type {ArtemisSave} from './save.js';

export interface ArtemisExitHost {
  /** Script +0xc70. */
  runMode(): number;
  /** c74 = c70, c70 = 14, then the scheduler owner (+0x10, virtual +0x30) with 0. */
  enterExitMode(): void;
  /** Display owner virtual +0xa8: the window is fullscreen. */
  fullscreen(): boolean;
  writeStatus(name: string, value: string): void;
}

/** Application exit of the script: the `exit` tag (0x1400c8380), `return` with an empty
 * caret stack (0x1400c8250) and the end of the root script in 0x1400c0560 share it. Unless a
 * load holds run mode 13, the script enters run mode 14, writes
 * `s.status.fullscreenatexit` and forces the global save. The window owner closes the
 * application after the frame that left run mode 14 (0x14013cec0 posts WM_DESTROY). */
export class ArtemisExit {
  constructor(
    private readonly save: ArtemisSave,
    private readonly host: ArtemisExitHost,
    private readonly loadRunMode = 13,
    private readonly publishesFullscreenAtExit = true,
  ) {}
  dispatch(tag: AsbTag): boolean {
    if (tag.name !== 'exit') return false;
    this.exit();
    return true;
  }
  exit(): void {
    const host = this.host;
    if (host.runMode() === this.loadRunMode) return;
    host.enterExitMode();
    if (this.publishesFullscreenAtExit)
      host.writeStatus('s.status.fullscreenatexit', host.fullscreen() ? '1' : '0');
    this.save.request('', false, true);
  }
}

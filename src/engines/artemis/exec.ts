import type {AsbTag} from '../../formats/artemis/asb.js';
import type {WindowStateHost} from '../../platform/window-state.js';
import type {ArtemisModes} from './modes.js';

export type ArtemisExecRequest = 'rightClick' | 'hide' | 'backlog';

export interface ArtemisExecHost {
  readonly window: WindowStateHost;
  /** c6160 entry (RunMode.enter); native refuses it from mode 13 and the request remains. */
  enterRunMode(mode: 4): void;
  /** timeGetTime after the shared timeBeginPeriod(1) (19a940), as uint32 milliseconds. */
  now(): number;
  /** Writes wait timestamp b94, which the frame owner c0560 compares. */
  setWaitStart(ms: number): void;
  /** Graphics byte f0, set by 14014d100 when the software renderer replaced the device. */
  softwareRenderer(): boolean;
  /** c28c0 reapplies device presentation and the side picture after the window toggle. */
  displayModeChanged(): void;
}

/** Native exec tag (0x1400d52c0). Commands compare exactly; unknown commands do nothing.
 * Right-click/hide/backlog set request bytes cc8/cc9/cca that the frame owner c0560 consumes.
 */
export class ArtemisExec {
  private readonly pending: Record<ArtemisExecRequest, boolean> = {
    rightClick: false,
    hide: false,
    backlog: false,
  };
  constructor(
    private readonly modes: ArtemisModes,
    private readonly host: ArtemisExecHost,
  ) {}

  requested(kind: ArtemisExecRequest): boolean {
    return this.pending[kind];
  }
  /** c0560 tests and clears each request byte. */
  consume(kind: ArtemisExecRequest): boolean {
    const active = this.pending[kind];
    this.pending[kind] = false;
    return active;
  }
  /** Constructor b9e80 and reset bf210 clear the request dword cc8..ccb. */
  clearRequests(): void {
    this.pending.rightClick = this.pending.hide = this.pending.backlog = false;
  }

  private request(kind: ArtemisExecRequest): void {
    this.pending[kind] = true;
    this.host.enterRunMode(4);
    this.host.setWaitStart(this.host.now() >>> 0);
  }
  /** Absent mode: automode enables, skip toggles. Otherwise exactly "0" disables. */
  private static active(tag: AsbTag, absent: boolean): boolean {
    return tag.args.has('mode') ? tag.args.get('mode') !== '0' : absent;
  }

  dispatch(tag: AsbTag): boolean {
    if (tag.name !== 'exec') return false;
    switch (tag.args.get('command') ?? '') {
      case 'rclick':
        this.request('rightClick');
        break;
      case 'automode':
        this.modes.setAutomode(ArtemisExec.active(tag, true), true);
        break;
      case 'skip':
        this.modes.setCommandSkip(ArtemisExec.active(tag, !this.modes.commandSkip), true);
        break;
      case 'hide':
        this.request('hide');
        break;
      case 'backlog':
        this.request('backlog');
        break;
      case 'fullscreen':
        // c2ad0(this, 0): no maximized-window query; the software renderer refuses the toggle.
        if (this.host.softwareRenderer()) break;
        this.host.window.toggleFullscreen();
        this.host.displayModeChanged();
        break;
      case 'minimize':
        this.host.window.show(this.host.window.minimized() ? 'restore' : 'minimize');
        break;
    }
    return true;
  }
}

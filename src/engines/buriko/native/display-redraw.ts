import type {BurikoNativeLocks} from './exclusion-locks.js';

/** Native request and procedure-redraw globals. Requesting redraw never presents a frame. */
export class BurikoDisplayRedraw {
  private locks: BurikoNativeLocks | null = null;
  pending = 0;
  /** The initialized DWORD in this executable is one. */
  mode = 1;
  /** 1c90ac starts at one; procedure completion consults it before requesting a redraw. */
  automaticEnabled = 1;
  /** 1d1d58 starts at zero; nonzero selects a full rather than damage redraw. */
  automaticMode = 0;

  bindLocks(locks: BurikoNativeLocks): void {
    if (this.locks !== null && this.locks !== locks)
      throw new Error('Buriko redraw requests belong to another engine lock owner');
    this.locks = locks;
  }

  /** 0b6250, called with one by b7370 and zero by b7380. */
  request(mode: number): void {
    this.locks?.enterEngine(1);
    if (this.pending === 0) {
      this.pending = 1;
      this.mode = mode | 0;
    } else this.mode |= mode;
    this.locks?.leaveEngine(1);
  }

  /** 06fee0 publishes the enable DWORD before the redraw-mode DWORD. */
  configureAutomatic(enabled: number, mode: number): void {
    this.automaticEnabled = enabled >>> 0;
    this.automaticMode = mode >>> 0;
  }
}

/** Native request globals 1e6c44/1c9130. Requesting redraw never presents a frame. */
export class AokanaDisplayRedraw {
  private locks: AokanaNativeLocks | null = null;
  pending = 0;
  /** The initialized DWORD in this executable is one. */
  mode = 1;

  bindLocks(locks: AokanaNativeLocks): void {
    if (this.locks !== null && this.locks !== locks)
      throw new Error('Aokana redraw requests belong to another engine lock owner');
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
}
import type {AokanaNativeLocks} from './exclusion-locks.js';

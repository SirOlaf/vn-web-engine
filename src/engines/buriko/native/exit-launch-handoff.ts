import type {BurikoWindowMessages} from './window-messages.js';

export interface BurikoExitLaunchRequest {
  readonly baseDirectory: Uint8Array | null;
  readonly command: Uint8Array;
  readonly failureMessage: Uint8Array | null;
}

/** E6B20's three owned globals and direct DestroyWindow ingress. */
export class BurikoExitLaunchHandoff {
  private pending: BurikoExitLaunchRequest | null = null;
  private tornDown = false;

  constructor(readonly messages: BurikoWindowMessages) {}

  get hasPendingLaunch(): boolean {
    return this.pending !== null;
  }

  request(
    baseDirectory: Uint8Array | null,
    command: Uint8Array,
    failureMessage: Uint8Array | null,
  ): 6 {
    if (this.tornDown) throw new Error('Buriko exit-and-launch handoff already passed teardown');
    this.pending = {
      baseDirectory: baseDirectory?.slice() ?? null,
      command: command.slice(),
      failureMessage: failureMessage?.slice() ?? null,
    };
    // DestroyWindow bypasses WM_CLOSE and its script close policy.
    if (this.messages.mainTarget() !== null) this.messages.send('main', 2, 0, 0);
    return 6;
  }

  /** The outer ED5F0 owner calls this only after engine teardown and COM release. */
  markEngineTornDown(): void {
    this.tornDown = true;
  }

  /** Read copied launch bytes while graph text and media owners are still available. */
  snapshotPendingForTeardown(): BurikoExitLaunchRequest | null {
    if (this.tornDown)
      throw new Error('Buriko exit-and-launch preparation must precede engine teardown');
    if (this.pending === null) return null;
    return {
      baseDirectory: this.pending.baseDirectory?.slice() ?? null,
      command: this.pending.command.slice(),
      failureMessage: this.pending.failureMessage?.slice() ?? null,
    };
  }

  takeAfterTeardown(): BurikoExitLaunchRequest | null {
    if (!this.tornDown)
      throw new Error('Buriko exit-and-launch command cannot run before engine teardown');
    const pending = this.pending;
    this.pending = null;
    return pending;
  }
}

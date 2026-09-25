import type {WindowsWindowTransitionProfile} from '../../../../../platform/windows-window-transitions.js';
import {AokanaBrowserMainWindow} from './browser-main-window.js';
import {AokanaNativeInput} from './input.js';
import {AokanaQueuedWindowDispatcher} from './queued-window-dispatch.js';

/** Selected scoped CloseWindow/restore producer. Its messages join before caller tail writes. */
export class AokanaMainWindowTransitions {
  readonly restoreButton: HTMLButtonElement;
  lastRestoreError: unknown = null;
  private closed = false;
  private pending: Promise<boolean> | null = null;

  constructor(
    readonly host: AokanaBrowserMainWindow,
    readonly input: AokanaNativeInput,
    readonly dispatcher: AokanaQueuedWindowDispatcher,
    readonly profile: WindowsWindowTransitionProfile,
    restoreContainer: HTMLElement,
  ) {
    if (
      !(host instanceof AokanaBrowserMainWindow) ||
      !(input instanceof AokanaNativeInput) ||
      !(dispatcher instanceof AokanaQueuedWindowDispatcher) ||
      host.display !== input.display ||
      dispatcher.messages.input !== input ||
      dispatcher.size?.host !== host ||
      dispatcher.activation?.host !== host ||
      !this.validOrder(profile.minimize) ||
      !this.validOrder(profile.restore) ||
      restoreContainer === host.parent ||
      (typeof host.parent.contains === 'function' && host.parent.contains(restoreContainer))
    )
      throw new Error('Aokana main transition requires selected ordered host and dispatch owners');
    const button = host.document.createElement('button');
    button.type = 'button';
    button.textContent = 'Restore';
    button.setAttribute('aria-label', 'Restore visual novel window');
    button.hidden = true;
    button.addEventListener('click', () => {
      void this.restore().catch((error: unknown) => {
        this.lastRestoreError = error;
        button.title = 'Restore failed';
      });
    });
    restoreContainer.append(button);
    this.restoreButton = button;
  }

  private validOrder(order: readonly string[]): boolean {
    return (
      order.length === 2 &&
      ((order[0] === 'size' && order[1] === 'activate') ||
        (order[0] === 'activate' && order[1] === 'size'))
    );
  }

  private run(operation: () => Promise<boolean>): Promise<boolean> {
    if (this.closed || this.pending !== null || this.dispatcher.hasPendingDispatch)
      throw new Error('Aokana main transition requires idle live admission');
    const work = operation();
    this.pending = work;
    void work.then(
      () => {
        if (this.pending === work) this.pending = null;
      },
      () => {
        if (this.pending === work) this.pending = null;
      },
    );
    return work;
  }

  private async deliver(
    order: WindowsWindowTransitionProfile['minimize'],
    size: number,
    activate: number,
    dimensions: readonly [number, number],
  ): Promise<void> {
    const packed = BigInt(dimensions[0] & 0xffff) | (BigInt(dimensions[1] & 0xffff) << 16n);
    for (const kind of order)
      await this.dispatcher.dispatchHostMainTransition({
        target: 'main',
        message: kind === 'size' ? 5 : 6,
        wParam: kind === 'size' ? size : activate,
        lParam: kind === 'size' ? packed : 0,
      });
  }

  /** CloseWindow's BOOL is separate from the later 80:65 input/latch writes. */
  minimize(): Promise<boolean> {
    return this.run(async () => {
      if (!this.host.minimizeScopedWindow()) return false;
      this.restoreButton.hidden = false;
      await this.deliver(this.profile.minimize, 1, 0, [0, 0]);
      return true;
    });
  }

  /** The visible control and host both use this joined restoration path. */
  restore(): Promise<boolean> {
    return this.run(async () => {
      if (!this.host.restoreScopedWindow()) return false;
      this.restoreButton.hidden = true;
      this.host.focus();
      await this.deliver(this.profile.restore, 0, 1, this.host.readClientNativeSize());
      return true;
    });
  }

  closeAndJoin(): Promise<void> {
    this.closed = true;
    return this.pending === null ? Promise.resolve() : this.pending.then(() => undefined);
  }

  dispose(): void {
    this.closed = true;
    this.restoreButton.remove();
  }
}

import type {AokanaBrowserMainWindow} from './browser-main-window.js';
import type {AokanaNativeInput} from './input.js';
import type {AokanaKeyboardMessages} from './keyboard-messages.js';
import type {AokanaWindowMessages} from './window-messages.js';
import {AokanaMainMouseInput, type AokanaMainWheelTranslator} from './main-mouse-input.js';
import {AokanaMainTouchInput, type AokanaBrowserTouchWindow} from './main-touch-input.js';
import type {AokanaNativeTouch} from './touch-input.js';

/** Scoped browser input ingress for the main canvas. Child and EDIT owners route themselves. */
export class AokanaMainDomInput {
  private disposed = false;
  private readonly originalTabIndex: number;
  private readonly view: Window | null;
  readonly mouse: AokanaMainMouseInput;
  readonly touch: AokanaMainTouchInput | null;

  constructor(
    readonly host: AokanaBrowserMainWindow,
    readonly input: AokanaNativeInput,
    readonly messages: AokanaWindowMessages,
    readonly keyboard: AokanaKeyboardMessages,
    wheel: AokanaMainWheelTranslator | null = null,
    touch: AokanaNativeTouch | null = null,
    touchWindow: AokanaBrowserTouchWindow | null = null,
  ) {
    if (
      input.display !== host.display ||
      messages.input !== input ||
      keyboard.messages !== messages ||
      messages.mainTarget() !== 'main'
    )
      throw new Error('Aokana main DOM input requires the shared live main-window owners');
    this.originalTabIndex = Number.isInteger(host.surface.tabIndex) ? host.surface.tabIndex : -1;
    if (!(host.surface.tabIndex >= 0)) host.surface.tabIndex = 0;
    this.view = host.document.defaultView;
    if ((touch === null) !== (touchWindow === null))
      throw new Error('Aokana main DOM input requires touch and touch window together');
    this.touch =
      touch !== null && touchWindow !== null
        ? new AokanaMainTouchInput(host, input, messages, touch, touchWindow)
        : null;
    this.mouse = new AokanaMainMouseInput(
      host,
      input,
      messages,
      wheel,
      this.touch === null ? null : (event) => this.touch!.suppressCompatibilityMouse(event),
    );
    host.surface.addEventListener('keydown', this.onKey);
    host.surface.addEventListener('keyup', this.onKey);
    host.parent.addEventListener('focusin', this.onFocusIn);
    host.parent.addEventListener('focusout', this.onFocusOut);
    host.document.addEventListener?.('visibilitychange', this.onVisibility);
    this.view?.addEventListener?.('blur', this.onWindowBlur);
    this.view?.addEventListener?.('focus', this.onWindowFocus);
    input.foreground = this.isScopedForeground();
  }

  private isScopedForeground(): boolean {
    // Minimal DOM fixtures may omit this browser Document method.
    return typeof this.host.document.hasFocus === 'function' && this.host.isForegroundWindow();
  }

  private readonly onKey = (event: KeyboardEvent): void => {
    if (
      this.disposed ||
      event.target !== this.host.surface ||
      this.host.document.activeElement !== this.host.surface ||
      !this.isScopedForeground() ||
      this.messages.mainTarget() !== 'main'
    )
      return;
    if (event.type === 'keyup' && !this.keyboard.isHeld(event.code, event.keyCode)) return;
    this.input.foreground = true;
    this.keyboard.post('main', event);
    event.preventDefault?.();
  };

  private readonly onFocusIn = (): void => {
    this.refreshForeground();
  };

  private readonly onFocusOut = (event: FocusEvent): void => {
    if (this.disposed) return;
    if (this.host.parent.contains(event.relatedTarget as Node)) return;
    // The browser updates activeElement after some focusout dispatches.
    queueMicrotask(() => {
      if (!this.disposed && !this.isScopedForeground()) this.deactivate();
    });
  };

  private readonly onVisibility = (): void => {
    this.refreshForeground();
  };

  private readonly onWindowBlur = (): void => {
    if (!this.disposed) this.deactivate();
  };

  private readonly onWindowFocus = (): void => {
    this.refreshForeground();
  };

  /** Reconcile direct ShowWindow and browser tab/window activation with the scoped HWND. */
  refreshForeground(): void {
    if (this.disposed) return;
    if (this.isScopedForeground()) this.input.foreground = true;
    else this.deactivate();
  }

  private deactivate(): void {
    this.input.foreground = false;
    this.keyboard.deactivate();
    this.mouse.deactivate();
    this.touch?.deactivate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.deactivate();
    this.host.surface.removeEventListener('keydown', this.onKey);
    this.host.surface.removeEventListener('keyup', this.onKey);
    this.host.parent.removeEventListener('focusin', this.onFocusIn);
    this.host.parent.removeEventListener('focusout', this.onFocusOut);
    this.host.document.removeEventListener?.('visibilitychange', this.onVisibility);
    this.view?.removeEventListener?.('blur', this.onWindowBlur);
    this.view?.removeEventListener?.('focus', this.onWindowFocus);
    this.mouse.dispose();
    this.touch?.dispose();
    this.host.surface.tabIndex = this.originalTabIndex;
  }
}

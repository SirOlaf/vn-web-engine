import {AokanaBrowserMainWindow} from './browser-main-window.js';
import {AokanaNativeInput} from './input.js';
import {AokanaQueuedWindowDispatcher} from './queued-window-dispatch.js';
import {AokanaWindowMessages} from './window-messages.js';

/** FF690/E85E0 show state on the one actual main HWND and its awaited paint owner. */
export class AokanaMainWindowShowState {
  private applying = false;

  constructor(
    readonly host: AokanaBrowserMainWindow,
    readonly input: AokanaNativeInput,
    readonly messages: AokanaWindowMessages,
    readonly dispatcher: AokanaQueuedWindowDispatcher,
  ) {
    if (
      !(host instanceof AokanaBrowserMainWindow) ||
      !(input instanceof AokanaNativeInput) ||
      !(messages instanceof AokanaWindowMessages) ||
      !(dispatcher instanceof AokanaQueuedWindowDispatcher) ||
      host.display !== input.display ||
      messages.input !== input ||
      dispatcher.messages !== messages ||
      dispatcher.paint.messages !== messages ||
      dispatcher.paint.device.canvas !== host.surface ||
      dispatcher.paint.device.display !== host.display
    )
      throw new Error('Aokana show state requires the shared main window and paint owners');
  }

  /** 80:64 clears transient keys after FF690, including when the HWND is not ready. */
  async setShowState(rawState: number): Promise<void> {
    if (this.applying) throw new Error('Aokana main show state is already applying');
    this.applying = true;
    try {
      await this.applyWindowShow(rawState >>> 0);
      this.input.clearTransientKeys();
    } finally {
      this.applying = false;
    }
  }

  private async applyWindowShow(rawState: number): Promise<void> {
    if (!this.host.isLiveMainWindow()) return;
    const display = this.host.display;
    if (rawState === 0) {
      this.host.showWindow(false);
    } else if (display.fullscreen === 0) {
      if (display.windowPositionPending !== 0) {
        const [x, y] = display.pendingWindowPosition;
        this.host.applyPosition(x, y);
        this.host.callbacks.geometryChanged(y);
      }
      this.host.showWindow(true, true);
      await this.dispatcher.updateMainWindow();
      display.windowPositionPending = 0;
    } else {
      display.windowPositionPending = 0;
    }
    display.windowMoveImmediate = rawState;
    this.host.refreshInputForeground();
    this.input.foreground = this.host.isForegroundWindow();
  }
}

import type {AokanaExternalProcessWindowHost} from './external-process.js';
import {AokanaMainWindowShowState} from './main-window-show-state.js';
import {AokanaQueuedWindowDispatcher} from './queued-window-dispatch.js';
import {AokanaGuiMessagePump} from './gui-message-pump.js';
import {BrowserWindowsCharacterTranslationHost} from '../../../../../platform/windows-character-translation.js';

/** C71F0's window operations on the graph's actual main HWND and queued GUI dispatch. */
export class AokanaExternalProcessWindow implements AokanaExternalProcessWindowHost {
  constructor(
    readonly showState: AokanaMainWindowShowState,
    readonly dispatcher: AokanaQueuedWindowDispatcher,
    readonly pump: AokanaGuiMessagePump = new AokanaGuiMessagePump(
      showState.messages,
      dispatcher,
      new BrowserWindowsCharacterTranslationHost(),
    ),
  ) {
    if (showState.dispatcher !== dispatcher || pump.dispatcher !== dispatcher)
      throw new Error('Aokana external-process window requires the shared GUI dispatcher');
  }

  readShowState(): number {
    return this.showState.host.display.windowMoveImmediate;
  }

  setShowState(value: number): Promise<void> {
    return this.showState.setShowState(value);
  }

  async pumpMessages(): Promise<number> {
    return this.pump.pumpMessages();
  }
}

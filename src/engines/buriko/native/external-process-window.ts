import type {BurikoExternalProcessWindowHost} from './external-process.js';
import {BurikoMainWindowShowState} from './main-window-show-state.js';
import {BurikoQueuedWindowDispatcher} from './queued-window-dispatch.js';
import {BurikoGuiMessagePump} from './gui-message-pump.js';
import {BrowserWindowsCharacterTranslationHost} from '../../../platform/windows-character-translation.js';

/** C71F0's window operations on the graph's actual main HWND and queued GUI dispatch. */
export class BurikoExternalProcessWindow implements BurikoExternalProcessWindowHost {
  constructor(
    readonly showState: BurikoMainWindowShowState,
    readonly dispatcher: BurikoQueuedWindowDispatcher,
    readonly pump: BurikoGuiMessagePump = new BurikoGuiMessagePump(
      showState.messages,
      dispatcher,
      new BrowserWindowsCharacterTranslationHost(),
    ),
  ) {
    if (showState.dispatcher !== dispatcher || pump.dispatcher !== dispatcher)
      throw new Error('Buriko external-process window requires the shared GUI dispatcher');
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

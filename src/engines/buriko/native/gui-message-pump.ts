import type {WindowsCharacterTranslationHost} from '../../../platform/windows-character-translation.js';
import type {BurikoQueuedWindowDispatcher} from './queued-window-dispatch.js';
import type {BurikoWindowMessages} from './window-messages.js';

/** 100860: remove, TranslateMessage, await DispatchMessage, then count. */
export class BurikoGuiMessagePump {
  constructor(
    readonly messages: BurikoWindowMessages,
    readonly dispatcher: BurikoQueuedWindowDispatcher,
    readonly translation: WindowsCharacterTranslationHost,
  ) {
    if (dispatcher.messages !== messages || typeof translation.translate !== 'function')
      throw new Error('Buriko GUI pump requires its selected queue, dispatcher and character host');
  }

  async pumpMessages(): Promise<number> {
    let count = 0;
    for (;;) {
      const event = this.messages.takePumpEvent();
      if (event === null) return count;
      if (event.kind === 'quit') return -1;
      const message = event.message;
      if (message.message === 0x100 || message.message === 0x104) {
        const characters = this.translation.translate(
          message.message,
          Number(BigInt.asUintN(32, BigInt(message.wParam))),
          this.messages.keyEvidence(message),
        );
        for (const character of characters) {
          if (
            (character.message !== 0x102 && character.message !== 0x106) ||
            !Number.isInteger(character.codeUnit) ||
            character.codeUnit < 0 ||
            character.codeUnit > 0xffff
          )
            throw new Error('Buriko character host returned an invalid Win32 character');
          this.messages.post({
            target: message.target,
            message: character.message,
            wParam: character.codeUnit,
            lParam: message.lParam,
          });
        }
      }
      await this.dispatcher.dispatchRemoved(event);
      count++;
    }
  }
}

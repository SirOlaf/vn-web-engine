import {AokanaKeyboardMessages, type AokanaKeyboardHotkeys} from './keyboard-messages.js';
import {
  AokanaWindowMessages,
  type AokanaWindowMessage,
  type AokanaWindowTarget,
} from './window-messages.js';

export interface AokanaHotkeyRegistration {
  register(target: AokanaWindowTarget | null, id: number, modifiers: number, key: number): boolean;
  unregister(target: AokanaWindowTarget | null, id: number): boolean;
}
interface Hotkey {
  readonly target: AokanaWindowTarget;
  readonly id: number;
  readonly modifiers: number;
  readonly key: number;
}

/** Selected browser capability: only delivered key events in the focused title surface.
 * No OS registration or global interception is claimed; unsupported calls return false.
 * This owner joins the existing physical translator and does not install a DOM listener. */
export class AokanaFocusedHotkeyRegistration
  implements AokanaHotkeyRegistration, AokanaKeyboardHotkeys
{
  readonly scope = 'focused-title-window';
  private readonly registrations: Hotkey[] = [];
  constructor(readonly keyboard: AokanaKeyboardMessages) {
    if (keyboard.hotkeys !== null)
      throw new Error('Aokana keyboard translator already has its hotkey owner');
    keyboard.hotkeys = this;
  }

  register(target: AokanaWindowTarget | null, id: number, modifiers: number, key: number): boolean {
    id >>>= 0;
    modifiers >>>= 0;
    key >>>= 0;
    if (
      target === null ||
      !this.keyboard.messages.hasTarget(target) ||
      id >= 16 ||
      modifiers >= 16 ||
      key !== 0x2c
    )
      return false;
    if (this.registrations.some((entry) => entry.key === key && entry.modifiers === modifiers))
      return false;
    this.registrations.push({target, id, modifiers, key});
    return true;
  }
  unregister(target: AokanaWindowTarget | null, id: number): boolean {
    const index = this.registrations.findIndex(
      (entry) => entry.target === target && entry.id === id >>> 0,
    );
    if (index < 0) return false;
    this.registrations.splice(index, 1);
    return true;
  }
  translate(key: number, modifiers: number, down: boolean): AokanaWindowMessage | null {
    if (!down) return null;
    const entry = this.registrations.find(
      (item) =>
        item.key === key &&
        item.modifiers === modifiers &&
        this.keyboard.messages.hasTarget(item.target),
    );
    return entry === undefined
      ? null
      : {
          target: entry.target,
          message: 0x312,
          wParam: entry.id,
          lParam: ((key << 16) | modifiers) >>> 0,
        };
  }
}

/** FF470's 277FA8 latch is independent of every RegisterHotKey/UnregisterHotKey BOOL. */
export class AokanaPrintScreenHotkeys {
  private enabled = 0;
  constructor(
    readonly messages: AokanaWindowMessages,
    readonly registration: AokanaHotkeyRegistration,
  ) {}

  setEnabled(value: number): void {
    if ((value | 0) !== 0) {
      if (this.enabled !== 0) return;
      for (let id = 0; id < 16; id++)
        this.registration.register(
          this.messages.hasTarget('main') ? 'main' : null,
          id,
          id & 15,
          0x2c,
        );
      this.enabled = 1;
    } else {
      if (this.enabled === 0) return;
      for (let id = 0; id < 16; id++)
        this.registration.unregister(this.messages.hasTarget('main') ? 'main' : null, id);
      this.enabled = 0;
    }
  }
}

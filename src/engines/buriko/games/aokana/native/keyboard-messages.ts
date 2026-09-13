import {
  AokanaWindowMessages,
  type AokanaWindowMessage,
  type AokanaWindowTarget,
} from './window-messages.js';

/** Windows scan codes associated with UI Events physical codes; zero has no Windows scan identity. */
const scanCodes: Readonly<Record<string, number>> = {
  ...Object.fromEntries(
    Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ', (letter, index) => [
      `Key${letter}`,
      [
        0x1e, 0x30, 0x2e, 0x20, 0x12, 0x21, 0x22, 0x23, 0x17, 0x24, 0x25, 0x26, 0x32, 0x31, 0x18,
        0x19, 0x10, 0x13, 0x1f, 0x14, 0x16, 0x2f, 0x11, 0x2d, 0x15, 0x2c,
      ][index]!,
    ]),
  ),
  ...Object.fromEntries(Array.from('1234567890', (digit, index) => [`Digit${digit}`, index + 2])),
  ...Object.fromEntries(Array.from({length: 10}, (_, index) => [`F${index + 1}`, index + 0x3b])),
  ...Object.fromEntries(Array.from({length: 11}, (_, index) => [`F${index + 13}`, index + 0x64])),
  Enter: 0x1c,
  Escape: 1,
  Backspace: 0x0e,
  Tab: 0x0f,
  Space: 0x39,
  Minus: 0x0c,
  Equal: 0x0d,
  BracketLeft: 0x1a,
  BracketRight: 0x1b,
  Backslash: 0x2b,
  Semicolon: 0x27,
  Quote: 0x28,
  Backquote: 0x29,
  Comma: 0x33,
  Period: 0x34,
  Slash: 0x35,
  CapsLock: 0x3a,
  F11: 0x57,
  F12: 0x58,
  F24: 0x76,
  PrintScreen: 0xe037,
  ScrollLock: 0x46,
  Pause: 0x45,
  Insert: 0xe052,
  Home: 0xe047,
  PageUp: 0xe049,
  Delete: 0xe053,
  End: 0xe04f,
  PageDown: 0xe051,
  ArrowRight: 0xe04d,
  ArrowLeft: 0xe04b,
  ArrowDown: 0xe050,
  ArrowUp: 0xe048,
  NumLock: 0xe045,
  NumpadDivide: 0xe035,
  NumpadMultiply: 0x37,
  NumpadSubtract: 0x4a,
  NumpadAdd: 0x4e,
  NumpadEnter: 0xe01c,
  Numpad1: 0x4f,
  Numpad2: 0x50,
  Numpad3: 0x51,
  Numpad4: 0x4b,
  Numpad5: 0x4c,
  Numpad6: 0x4d,
  Numpad7: 0x47,
  Numpad8: 0x48,
  Numpad9: 0x49,
  Numpad0: 0x52,
  NumpadDecimal: 0x53,
  NumpadEqual: 0x59,
  NumpadComma: 0x7e,
  IntlBackslash: 0x56,
  IntlRo: 0x73,
  IntlYen: 0x7d,
  ContextMenu: 0xe05d,
  ControlLeft: 0x1d,
  ControlRight: 0xe01d,
  ShiftLeft: 0x2a,
  ShiftRight: 0x36,
  AltLeft: 0x38,
  AltRight: 0xe038,
  MetaLeft: 0xe05b,
  MetaRight: 0xe05c,
  KanaMode: 0x70,
  Convert: 0x79,
  NonConvert: 0x7b,
  Lang1: 0x72,
  Lang2: 0x71,
  Lang3: 0x78,
  Lang4: 0x77,
  Help: 0xe03b,
  Undo: 0xe008,
  Cut: 0xe017,
  Copy: 0xe018,
  Paste: 0xe00a,
  AudioVolumeMute: 0xe020,
  AudioVolumeUp: 0xe030,
  AudioVolumeDown: 0xe02e,
  MediaTrackNext: 0xe019,
  MediaTrackPrevious: 0xe010,
  MediaStop: 0xe024,
  MediaPlayPause: 0xe022,
  MediaSelect: 0xe06d,
  Eject: 0xe02c,
  LaunchMail: 0xe06c,
  LaunchApp1: 0xe06b,
  LaunchApp2: 0xe021,
  BrowserSearch: 0xe065,
  BrowserHome: 0xe032,
  BrowserBack: 0xe06a,
  BrowserForward: 0xe069,
  BrowserStop: 0xe068,
  BrowserRefresh: 0xe067,
  BrowserFavorites: 0xe066,
  Power: 0xe05e,
  Sleep: 0xe05f,
  WakeUp: 0xe063,
};
export function aokanaWindowsScanCode(code: string): number {
  return scanCodes[code] ?? 0;
}
const modifiers: Readonly<Record<string, {key: number; side: number; other: string}>> = {
  ShiftLeft: {key: 0x10, side: 0xa0, other: 'ShiftRight'},
  ShiftRight: {key: 0x10, side: 0xa1, other: 'ShiftLeft'},
  ControlLeft: {key: 0x11, side: 0xa2, other: 'ControlRight'},
  ControlRight: {key: 0x11, side: 0xa3, other: 'ControlLeft'},
  AltLeft: {key: 0x12, side: 0xa4, other: 'AltRight'},
  AltRight: {key: 0x12, side: 0xa5, other: 'AltLeft'},
};

export type AokanaKeyboardEvent = Pick<
  KeyboardEvent,
  'type' | 'code' | 'keyCode' | 'repeat' | 'getModifierState'
>;

/** The one focused-host hotkey owner is consulted by the existing physical translator. */
export interface AokanaKeyboardHotkeys {
  translate(key: number, modifiers: number, down: boolean): AokanaWindowMessage | null;
}

/** Shared Chromium input profile. Browser keyCode retains the active layout's logical virtual key. */
export class AokanaKeyboardMessages {
  hotkeys: AokanaKeyboardHotkeys | null = null;
  private readonly held = new Set<string>();
  private altMenuPending = false;
  private syntheticAltGraphControl = false;

  constructor(readonly messages: AokanaWindowMessages) {}

  post(target: AokanaWindowTarget, event: AokanaKeyboardEvent): void {
    if (event.type !== 'keydown' && event.type !== 'keyup')
      throw new TypeError('Aokana keyboard translator requires a key transition');
    const down = event.type === 'keydown';
    if (
      event.code === 'AltRight' &&
      down &&
      event.getModifierState('AltGraph') &&
      !this.held.has('ControlLeft') &&
      !this.held.has('ControlRight')
    ) {
      this.transition(target, 'ControlLeft', 0x11, true, false);
      this.syntheticAltGraphControl = true;
    }
    if (event.code === 'AltRight' && !down && this.syntheticAltGraphControl) {
      this.transition(target, 'ControlLeft', 0x11, false, false);
      this.syntheticAltGraphControl = false;
    }
    this.transition(target, event.code, event.keyCode, down, event.repeat);
  }

  private transition(
    target: AokanaWindowTarget,
    code: string,
    browserKey: number,
    down: boolean,
    repeat: boolean,
  ): void {
    const modifier = modifiers[code],
      key =
        modifier?.key ??
        (code === 'MetaLeft'
          ? 0x5b
          : code === 'MetaRight'
            ? 0x5c
            : code === 'ContextMenu'
              ? 0x5d
              : browserKey);
    if (!Number.isInteger(key) || key < 0 || key > 255)
      throw new RangeError('Aokana browser virtual key exceeds the native key array');
    const identity = code || `virtual:${key}`,
      wasDown = this.held.has(identity);
    const alt = this.held.has('AltLeft') || this.held.has('AltRight');
    const control = this.held.has('ControlLeft') || this.held.has('ControlRight');
    let system = false;
    if (key === 0x12) {
      if (down) {
        system = !control;
        if (system) this.altMenuPending = true;
      } else if (alt && this.altMenuPending) {
        system = true;
        this.altMenuPending = false;
      }
    } else if (key === 0x11) {
      if (!down && alt) {
        system = true;
        this.altMenuPending = false;
      }
    } else if (key === 0x79 || (alt && !control)) {
      system = true;
      this.altMenuPending = false;
    }
    if (down) this.held.add(identity);
    else this.held.delete(identity);
    const transitions =
      modifier === undefined
        ? [{key, down}]
        : [
            {key: modifier.side, down},
            {key, down: down || this.held.has(modifier.other)},
          ];
    const scan = aokanaWindowsScanCode(code);
    const altContext = this.held.has('AltLeft') || this.held.has('AltRight');
    const lParam =
      (1 |
        ((scan & 255) << 16) |
        ((scan & 0xff00) === 0xe000 ? 0x1000000 : 0) |
        (altContext ? 0x20000000 : 0) |
        (!down || wasDown || repeat ? 0x40000000 : 0) |
        (down ? 0 : 0x80000000)) >>>
      0;
    const hotkeyModifiers =
      Number(altContext) |
      (Number(this.held.has('ControlLeft') || this.held.has('ControlRight')) << 1) |
      (Number(this.held.has('ShiftLeft') || this.held.has('ShiftRight')) << 2) |
      (Number(this.held.has('MetaLeft') || this.held.has('MetaRight')) << 3);
    const hotkey = this.hotkeys?.translate(key, hotkeyModifiers, down) ?? null;
    this.messages.enqueuePhysicalTransitions(
      hotkey ?? {target, message: (system ? 0x104 : 0x100) + Number(!down), wParam: key, lParam},
      transitions,
      hotkey !== null,
    );
  }
}

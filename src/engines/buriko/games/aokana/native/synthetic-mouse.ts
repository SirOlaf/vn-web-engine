import type {AokanaNativeInput} from './input.js';
import type {AokanaWindowMessages} from './window-messages.js';

const ASYNC_BUTTON_FLAGS: readonly (readonly [key: number, flag: number])[] = [
  [0x11, 0x08],
  [0x01, 0x01],
  [0x04, 0x10],
  [0x02, 0x02],
  [0x10, 0x04],
  [0x05, 0x20],
  [0x06, 0x40],
];

interface SyntheticMousePair {
  readonly downMessage: number;
  readonly downParameter: number;
  readonly upMessage: number;
  readonly upParameter: number;
}

function messagePair(button: number, flags: number): SyntheticMousePair | null {
  switch (button | 0) {
    case 1:
      return {downMessage: 0x201, downParameter: flags | 1, upMessage: 0x202, upParameter: flags};
    case 2:
      return {downMessage: 0x204, downParameter: flags | 2, upMessage: 0x205, upParameter: flags};
    case 4:
      return {
        downMessage: 0x207,
        downParameter: flags | 0x10,
        upMessage: 0x208,
        upParameter: flags,
      };
    case 5:
      return {
        downMessage: 0x20b,
        downParameter: (flags & 0xffff) | 0x10020,
        upMessage: 0x20c,
        upParameter: (flags & 0xffff) | 0x10000,
      };
    case 6:
      return {
        downMessage: 0x20b,
        downParameter: (flags & 0xffff) | 0x20040,
        upMessage: 0x20c,
        upParameter: (flags & 0xffff) | 0x20000,
      };
    default:
      return null;
  }
}

/** 1400c4030's synchronous GetAsyncKeyState/GetCursorPos/SendMessageW lower. */
export class AokanaSyntheticMouse {
  constructor(
    readonly input: AokanaNativeInput,
    readonly messages: AokanaWindowMessages,
  ) {}

  click(button: number): 0 | 1 {
    let flags = 0;
    for (const [key, flag] of ASYNC_BUTTON_FLAGS) {
      if ((this.input.asynchronousKeyState(key) & 0x8000) !== 0) flags |= flag;
    }
    const [screenX, screenY] = this.input.screenCursorPosition(),
      lParam = ((screenX & 0xffff) | ((screenY & 0xffff) << 16)) >>> 0,
      pair = messagePair(button, flags);
    if (pair === null) return 0;
    // The native HWND global is loaded independently immediately before each SendMessageW.
    this.messages.send(this.messages.mainTarget(), pair.downMessage, pair.downParameter, lParam);
    this.messages.send(this.messages.mainTarget(), pair.upMessage, pair.upParameter, lParam);
    return 1;
  }
}

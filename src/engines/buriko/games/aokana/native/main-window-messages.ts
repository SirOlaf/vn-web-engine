import type {AokanaBrowserMainWindow} from './browser-main-window.js';
import type {AokanaNativeInput} from './input.js';
import type {AokanaKnobDisplays} from './knob-displays.js';
import type {AokanaNativeNotifications} from './notification-queue.js';
import type {AokanaWindowMessages as AokanaWaitWindowMessages} from './procedure.js';
import type {
  AokanaWindowMessage,
  AokanaWindowMessageReceiver,
  AokanaWindowMessages,
} from './window-messages.js';

type AokanaMainWindowFocus = Pick<AokanaBrowserMainWindow, 'focus'>;

function nativeParameter(value: number | bigint): bigint {
  return BigInt.asUintN(64, typeof value === 'bigint' ? value : BigInt(value));
}

function lowWord(value: number | bigint): number {
  return Number(nativeParameter(value) & 0xffffn);
}

function highWord(value: number | bigint): number {
  return Number((nativeParameter(value) >> 16n) & 0xffffn);
}

/**
 * The synchronous main HWND receiver slice used by physical/dequeued and SendMessage traffic.
 * 1400ff770 broadcasts through 1400fee00 before entering any ordinary mouse handler.
 */
export class AokanaMainWindowMessageReceiver implements AokanaWindowMessageReceiver {
  private leftKnobSuppressed = false;
  private rightKnobSuppressed = false;

  constructor(
    readonly messages: AokanaWindowMessages,
    readonly waits: AokanaWaitWindowMessages,
    readonly input: AokanaNativeInput,
    readonly notifications: AokanaNativeNotifications,
    readonly window: AokanaMainWindowFocus,
    readonly knobs: AokanaKnobDisplays,
  ) {
    messages.bindMainReceiver(this);
  }

  receive(message: AokanaWindowMessage): number | bigint {
    this.waits.dispatch(
      message.message,
      nativeParameter(message.wParam),
      nativeParameter(message.lParam),
    );
    switch (message.message >>> 0) {
      case 0x201:
        this.leftDown(message);
        break;
      case 0x202:
        this.leftUp();
        break;
      case 0x203:
        this.notifications.push(0x80, 0, 0);
        this.leftDown(message);
        break;
      case 0x204:
        this.rightDown(message);
        break;
      case 0x205:
        this.rightUp(message);
        break;
      case 0x206:
        this.notifications.push(0x81, 0, 0);
        this.rightDown(message);
        break;
      case 0x207:
        this.ordinaryDown(message, 2, 4);
        break;
      case 0x208:
        this.input.recordKeyUp(4);
        break;
      case 0x20a:
        this.verticalWheel(message);
        break;
      case 0x20b:
        this.xDown(message);
        break;
      case 0x20c:
        this.input.recordKeyUp(this.xButtonIndex(message) + 5);
        break;
      case 0x20e:
        this.horizontalWheel(message);
        break;
    }
    // The browser has no additional DefWindowProc mouse result for this exact handled slice.
    return 0;
  }

  private leftDown(message: AokanaWindowMessage): void {
    this.saveClick(message, 0);
    this.input.incrementActivityGeneration();
    this.notifications.push(3, 1, 0);
    this.window.focus();
    const receiver = this.knobs.findPointerReceiver();
    if (receiver === null) {
      this.input.recordKeyDown(1);
      this.leftKnobSuppressed = false;
      return;
    }
    const [x, y] = this.input.pointerPosition();
    this.knobs.beginPointerInteraction(receiver, x, y);
    this.input.recordKeyCount(1);
    this.leftKnobSuppressed = true;
  }

  private leftUp(): void {
    if (this.leftKnobSuppressed) this.leftKnobSuppressed = false;
    else this.input.recordKeyUp(1);
  }

  private rightDown(message: AokanaWindowMessage): void {
    const mode = this.input.mouseButtonMode | 0;
    if (mode === 1) {
      this.messages.send(message.target, 0x201, message.wParam, message.lParam);
      return;
    }
    if (mode !== 0) return;
    this.saveClick(message, 1);
    this.input.incrementActivityGeneration();
    this.notifications.push(3, 2, 0);
    this.window.focus();
    const receiver = this.knobs.findPointerReceiver();
    if (receiver === null) {
      this.input.recordKeyDown(2);
      this.rightKnobSuppressed = false;
      return;
    }
    this.knobs.latchRightClick(receiver);
    this.input.recordKeyCount(2);
    this.rightKnobSuppressed = true;
  }

  private rightUp(message: AokanaWindowMessage): void {
    const mode = this.input.mouseButtonMode | 0;
    if (mode === 1) {
      this.messages.send(message.target, 0x202, message.wParam, message.lParam);
      return;
    }
    if (mode !== 0) return;
    if (this.rightKnobSuppressed) this.rightKnobSuppressed = false;
    else this.input.recordKeyUp(2);
  }

  private ordinaryDown(message: AokanaWindowMessage, slot: number, key: number): void {
    this.saveClick(message, slot);
    this.input.incrementActivityGeneration();
    this.notifications.push(3, key, 0);
    this.window.focus();
    this.input.recordKeyDown(key);
  }

  private xDown(message: AokanaWindowMessage): void {
    const index = this.xButtonIndex(message),
      key = index + 5;
    this.saveClick(message, index + 3);
    this.input.incrementActivityGeneration();
    // 140100159 focuses before 14010016c appends the X-button notification.
    this.window.focus();
    this.notifications.push(3, key, 0);
    this.input.recordKeyDown(key);
  }

  private verticalWheel(message: AokanaWindowMessage): void {
    const delta = highWord(message.wParam);
    if (delta === 0) return;
    const negative = Number((delta & 0x8000) !== 0),
      key = negative + 0x0e;
    this.input.incrementActivityGeneration();
    this.notifications.push(3, key, 0);
    if (this.knobs.wheelModeValue() !== 0 && this.knobs.handleWheel(negative)) return;
    this.input.recordKeyDown(key);
    this.input.recordKeyUp(key);
  }

  private horizontalWheel(message: AokanaWindowMessage): void {
    const delta = highWord(message.wParam);
    if (delta === 0) return;
    const key = (delta & 0x8000) !== 0 ? 0x8e : 0x8f;
    this.input.incrementActivityGeneration();
    this.notifications.push(3, key, 0);
    this.input.recordKeyDown(key);
    this.input.recordKeyUp(key);
  }

  private xButtonIndex(message: AokanaWindowMessage): number {
    return ~highWord(message.wParam) & 1;
  }

  private saveClick(message: AokanaWindowMessage, slot: number): void {
    this.input.recordClickPosition(slot, lowWord(message.lParam), highWord(message.lParam));
  }
}

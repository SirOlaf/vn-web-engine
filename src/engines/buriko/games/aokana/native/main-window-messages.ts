import type {AokanaBrowserMainWindow} from './browser-main-window.js';
import type {AokanaNativeInput} from './input.js';
import type {AokanaKnobDisplays} from './knob-displays.js';
import type {AokanaNativeNotifications} from './notification-queue.js';
import type {AokanaDisplayController} from './display-controller.js';
import type {AokanaCursorShapes} from './cursor-shapes.js';
import type {AokanaDroppedFiles} from './dropped-files.js';
import type {AokanaInlineTextControl} from './inline-text-control.js';
import type {AokanaWindowMessages as AokanaWaitWindowMessages} from './procedure.js';
import type {
  AokanaWindowMessage,
  AokanaWindowMessageReceiver,
  AokanaWindowMessages,
} from './window-messages.js';

type AokanaMainWindowFocus = Pick<AokanaBrowserMainWindow, 'focus'>;
export interface AokanaMainWindowLifecycle {
  readonly host: AokanaBrowserMainWindow;
  readonly inline: AokanaInlineTextControl;
}

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
  private ready = false;
  private destroyed = false;
  private deferDetach = false;

  constructor(
    readonly messages: AokanaWindowMessages,
    readonly waits: AokanaWaitWindowMessages,
    readonly input: AokanaNativeInput,
    readonly notifications: AokanaNativeNotifications,
    readonly window: AokanaMainWindowFocus,
    readonly knobs: AokanaKnobDisplays,
    readonly controller: AokanaDisplayController | null = null,
    readonly cursorShapes: AokanaCursorShapes | null = null,
    readonly droppedFiles: AokanaDroppedFiles | null = null,
    readonly lifecycle: AokanaMainWindowLifecycle | null = null,
  ) {
    if (
      controller !== null &&
      (controller.messages !== messages ||
        messages.input !== input ||
        controller.notifications !== notifications)
    )
      throw new Error('Aokana keyboard receiver requires the shared display/input/message owners');
    if (cursorShapes !== null && cursorShapes.messages !== messages)
      throw new Error('Aokana cursor receiver requires the shared message owner');
    if (droppedFiles !== null && droppedFiles.messages !== messages)
      throw new Error('Aokana drop receiver requires the shared message owner');
    if (
      lifecycle !== null &&
      (lifecycle.host !== window ||
        lifecycle.host.display !== input.display ||
        lifecycle.inline.host !== lifecycle.host ||
        lifecycle.inline.messages !== messages)
    )
      throw new Error('Aokana lifecycle receiver requires the shared main host and inline owner');
    messages.bindMainReceiver(this);
  }

  isReady(): boolean {
    return this.ready;
  }

  receive(message: AokanaWindowMessage): number | bigint {
    this.waits.dispatch(
      message.message,
      nativeParameter(message.wParam),
      nativeParameter(message.lParam),
    );
    switch (message.message >>> 0) {
      case 0xf:
        throw new Error('Aokana main WM_PAINT requires awaited queued dispatch');
      case 1:
        this.requireLifecycle();
        this.ready = true;
        return 0;
      case 0x10: {
        const {host, inline} = this.requireLifecycle();
        this.input.incrementActivityGeneration();
        if (host.closePolicy === 0) {
          this.notifications.push(2, 0, 0);
          return 0;
        }
        inline.close();
        if (this.messages.mainTarget() === null)
          throw new Error('Aokana WM_CLOSE requires the live main target for nested destruction');
        this.deferDetach = true;
        try {
          this.messages.send('main', 2, 0, 0);
        } finally {
          this.deferDetach = false;
        }
        host.detachScopedWindow();
        return 0;
      }
      case 2: {
        const {host} = this.requireLifecycle();
        this.ready = false;
        if (!this.destroyed) {
          this.destroyed = true;
          this.messages.forgetTarget('main');
          this.messages.postQuit(0);
        }
        if (!this.deferDetach) host.detachScopedWindow();
        return 0;
      }
      case 0x233:
        this.notifications.push(0x10, 0, 0);
        if (this.droppedFiles === null)
          throw new Error('Aokana WM_DROPFILES requires the actual mounted drop owner');
        this.droppedFiles.receive(Number(nativeParameter(message.wParam)));
        return 0;
      case 0x9000:
        this.notifications.push(0x10, 0, 0);
        throw new Error(
          'Aokana message9000 requires the unimplemented named-file-mapping IPC owner',
        );
      case 0x9001:
        this.notifications.push(0x11, 0, 0);
        return 0;
      case 0x20:
        if (this.cursorShapes === null)
          throw new Error('Aokana WM_SETCURSOR requires the actual cursor shape owner');
        this.cursorShapes.applySelected();
        return this.cursorShapes.defaultClientCursor(lowWord(message.lParam));
      case 0x100: {
        const key = Number(nativeParameter(message.wParam) & 0xffffffffn);
        if (this.input.keyOption(key) !== 0) this.input.recordKeyUp(key);
        this.keyDown(key);
        break;
      }
      case 0x101:
        this.input.recordKeyUp(Number(nativeParameter(message.wParam) & 0xffffffffn));
        break;
      case 0x104: {
        const key = nativeParameter(message.wParam);
        if (key === 0x0dn) {
          if (this.input.inputActive && (nativeParameter(message.lParam) & 0x40000000n) === 0n)
            this.keyboardController().requestModeToggle();
        } else if (key === 0x73n) {
          const target = this.messages.mainTarget();
          if (target !== null) this.messages.post({target, message: 0x10, wParam: 0, lParam: 0});
        } else if (key === 0x79n) this.keyDown(0x79);
        break;
      }
      case 0x105: {
        const key = nativeParameter(message.wParam);
        if (key === 0x12n) this.keyDown(0x12);
        else if (key !== 0x79n) break;
        this.input.recordKeyUp(Number(key));
        break;
      }
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
    // This profile has no additional DefWindowProc result for these handled input messages.
    return 0;
  }

  private requireLifecycle(): AokanaMainWindowLifecycle {
    if (this.lifecycle === null)
      throw new Error('Aokana main-window lifecycle requires the shared host and inline owner');
    return this.lifecycle;
  }

  private keyboardController(): AokanaDisplayController {
    if (this.controller === null)
      throw new Error('Aokana main keyboard receiver requires a display controller');
    return this.controller;
  }

  private keyDown(key: number): void {
    if (!this.input.recordKeyDown(key)) return;
    this.input.incrementActivityGeneration();
    this.notifications.push(3, key, 0);
    const controller = this.keyboardController();
    if (controller.containsModeToggleKey(key)) controller.requestModeToggle();
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

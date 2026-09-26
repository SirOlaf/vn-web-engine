import type {BurikoBrowserMainWindow} from './browser-main-window.js';
import type {BurikoNativeInput} from './input.js';
import type {BurikoWindowMessages} from './window-messages.js';
import type {BurikoNativeTouchSample, BurikoNativeTouchWindow} from './touch-input.js';
import {BurikoNativeTouch} from './touch-input.js';

/** Explicit selected device capability; browser PointerEvent support alone is not the native digitizer gate. */
export class BurikoBrowserTouchWindow implements BurikoNativeTouchWindow {
  registered = false;
  registrationEpoch = 0;
  private readonly registrationListeners = new Set<() => void>();

  constructor(
    readonly host: BurikoBrowserMainWindow,
    readonly available: boolean,
  ) {}

  register(_flags: 1): number {
    if (!this.available) return 0;
    this.registered = true;
    this.registrationEpoch++;
    for (const listener of this.registrationListeners) listener();
    return 1;
  }

  unregister(): number {
    if (!this.available) return 0;
    this.registered = false;
    this.registrationEpoch++;
    for (const listener of this.registrationListeners) listener();
    return 1;
  }

  subscribeRegistration(listener: () => void): () => void {
    this.registrationListeners.add(listener);
    return () => this.registrationListeners.delete(listener);
  }

  screenToClient(x: number, y: number): readonly [number, number] {
    const anchor = this.host.mapCanvasViewportPoint(0, 0);
    return [x - anchor.screenX + anchor.clientX, y - anchor.screenY + anchor.clientY];
  }
}

/** Scoped PointerEvent profile: registered contacts receive WM_TOUCH; primary contact also owns mouse input. */
export class BurikoMainTouchInput {
  private readonly active = new Set<number>();
  private primary: number | null = null;
  private registrationEpoch: number;
  private readonly priorTouchAction: string;
  private readonly unsubscribeRegistration: () => void;
  private disposed = false;
  private lastTouchX = NaN;
  private lastTouchY = NaN;
  private suppressMouseUntil = 0;

  constructor(
    readonly host: BurikoBrowserMainWindow,
    readonly input: BurikoNativeInput,
    readonly messages: BurikoWindowMessages,
    readonly touch: BurikoNativeTouch,
    readonly touchWindow: BurikoBrowserTouchWindow,
  ) {
    if (
      input.display !== host.display ||
      messages.input !== input ||
      messages.mainTarget() !== 'main' ||
      touch.input !== input ||
      touch.window !== touchWindow ||
      touchWindow.host !== host
    )
      throw new Error('Buriko main touch requires the shared live main-window owners');
    this.registrationEpoch = touchWindow.registrationEpoch;
    this.unsubscribeRegistration = touchWindow.subscribeRegistration(() => this.syncRegistration());
    this.priorTouchAction = host.surface.style.touchAction;
    if (touchWindow.available) {
      host.surface.style.touchAction = 'none';
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const)
        host.surface.addEventListener(type, this.onPointer);
      host.surface.addEventListener('lostpointercapture', this.onLostCapture);
    }
  }

  private live(): boolean {
    return (
      !this.disposed &&
      this.touchWindow.available &&
      this.host.isLiveMainWindow() &&
      this.host.parent.style.visibility !== 'hidden' &&
      this.host.document.visibilityState !== 'hidden'
    );
  }

  private syncRegistration(): void {
    if (this.registrationEpoch === this.touchWindow.registrationEpoch) return;
    this.deactivate();
    this.registrationEpoch = this.touchWindow.registrationEpoch;
  }

  private sample(
    event: PointerEvent,
    flags: number,
  ): {
    sample: BurikoNativeTouchSample;
    clientX: number;
    clientY: number;
    screenX: number;
    screenY: number;
  } {
    const point = this.host.mapCanvasViewportPoint(event.clientX, event.clientY);
    const width = event.width,
      height = event.height;
    let contactWidth = 0,
      contactHeight = 0,
      mask = 0;
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      const right = this.host.mapCanvasViewportPoint(event.clientX + width, event.clientY),
        bottom = this.host.mapCanvasViewportPoint(event.clientX, event.clientY + height);
      contactWidth = Math.abs(right.screenX - point.screenX) * 100;
      contactHeight = Math.abs(bottom.screenY - point.screenY) * 100;
      mask |= 4;
    }
    let time = 0;
    if (Number.isFinite(event.timeStamp) && event.timeStamp >= 0 && event.timeStamp <= 0xffffffff) {
      time = Math.trunc(event.timeStamp);
      mask |= 1;
    }
    return {
      sample: {
        id: event.pointerId >>> 0,
        x: point.screenX * 100,
        y: point.screenY * 100,
        flags,
        mask,
        time,
        contactWidth,
        contactHeight,
      },
      ...point,
    };
  }

  private updatePointer(point: {
    clientX: number;
    clientY: number;
    screenX: number;
    screenY: number;
  }): void {
    this.input.pointerAvailable = true;
    this.input.pointerClientX = point.clientX;
    this.input.pointerClientY = point.clientY;
    this.input.pointerScreenX = point.screenX;
    this.input.pointerScreenY = point.screenY;
  }

  private mouseMessage(event: PointerEvent, message: number, x: number, y: number): void {
    const lParam = ((x & 0xffff) | ((y & 0xffff) << 16)) >>> 0,
      wParam = (message === 0x202 ? 0 : 1) | (event.shiftKey ? 4 : 0) | (event.ctrlKey ? 8 : 0);
    this.messages.enqueueTouchMouse(
      {target: 'main', message, wParam, lParam},
      message === 0x200 ? [] : [{key: 1, down: message === 0x201}],
    );
    this.lastTouchX = event.clientX;
    this.lastTouchY = event.clientY;
    this.suppressMouseUntil = Date.now() + 750;
  }

  private handlePointer(event: PointerEvent, type = event.type): void {
    if (event.pointerType !== 'touch') return;
    this.syncRegistration();
    if (!this.live()) return;
    const id = event.pointerId >>> 0,
      down = type === 'pointerdown',
      ending = type === 'pointerup' || type === 'pointercancel';
    if (down) {
      if (event.target !== this.host.surface || this.active.has(id)) return;
    } else if (!this.active.has(id)) return;
    const primary = down ? event.isPrimary && this.primary === null : this.primary === id;
    const point = this.sample(event, down ? (primary ? 0x12 : 2) : ending ? 4 : 1);
    // RegisterTouchWindow gates WM_TOUCH, not the OS's primary-contact mouse stream.
    if (this.touchWindow.registered && !this.messages.enqueuePhysicalTouch([point.sample])) {
      this.deactivate();
      event.preventDefault();
      return;
    }
    if (down) {
      this.active.add(id);
      if (primary) {
        this.primary = id;
        this.host.focus();
      }
      this.host.surface.setPointerCapture?.(event.pointerId);
    }
    if (primary) {
      this.updatePointer(point);
      this.mouseMessage(event, down ? 0x201 : ending ? 0x202 : 0x200, point.clientX, point.clientY);
      if (ending) this.primary = null;
    }
    if (ending) {
      this.active.delete(id);
      if (this.host.surface.hasPointerCapture?.(event.pointerId))
        this.host.surface.releasePointerCapture(event.pointerId);
    }
    event.preventDefault();
  }

  private readonly onPointer = (event: PointerEvent): void => {
    this.handlePointer(event);
  };

  private readonly onLostCapture = (event: PointerEvent): void => {
    if (event.pointerType === 'touch' && this.active.has(event.pointerId >>> 0))
      this.handlePointer(event, 'pointercancel');
  };

  /** The selected profile owns primary touch mouse messages and discards browser duplicates. */
  suppressCompatibilityMouse(event: MouseEvent): boolean {
    if (!this.touchWindow.available || this.disposed) return false;
    const capabilities = (
      event as MouseEvent & {
        sourceCapabilities?: {firesTouchEvents?: boolean};
      }
    ).sourceCapabilities;
    if (capabilities?.firesTouchEvents === true) return true;
    return (
      (this.primary !== null || Date.now() < this.suppressMouseUntil) &&
      Math.abs(event.clientX - this.lastTouchX) <= 8 &&
      Math.abs(event.clientY - this.lastTouchY) <= 8
    );
  }

  deactivate(): void {
    this.messages.cancelPendingTouchBatches();
    this.messages.cancelPendingTouchMouse();
    if (this.primary !== null) this.messages.releasePhysicalKeys([1]);
    this.active.clear();
    this.primary = null;
    this.touch.clearContacts();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.deactivate();
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const)
      this.host.surface.removeEventListener(type, this.onPointer);
    this.host.surface.removeEventListener('lostpointercapture', this.onLostCapture);
    this.host.surface.style.touchAction = this.priorTouchAction;
    this.unsubscribeRegistration();
    this.touchWindow.unregister();
  }
}

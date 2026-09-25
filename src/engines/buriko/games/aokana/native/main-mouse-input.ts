import type {AokanaBrowserMainWindow} from './browser-main-window.js';
import type {AokanaNativeInput} from './input.js';
import type {AokanaWindowMessages} from './window-messages.js';

const BUTTONS = [
  {dom: 0, bit: 1, key: 1, down: 0x201, double: 0x203, up: 0x202},
  {dom: 2, bit: 2, key: 2, down: 0x204, double: 0x206, up: 0x205},
  {dom: 1, bit: 4, key: 4, down: 0x207, double: 0x209, up: 0x208},
  {dom: 3, bit: 8, key: 5, down: 0x20b, double: 0x20d, up: 0x20c},
  {dom: 4, bit: 16, key: 6, down: 0x20b, double: 0x20d, up: 0x20c},
] as const;

function mouseFlags(buttons: number, shift: boolean, control: boolean): number {
  return (
    (buttons & 3) |
    ((buttons & 4) << 2) |
    ((buttons & 8) << 2) |
    ((buttons & 16) << 2) |
    (shift ? 4 : 0) |
    (control ? 8 : 0)
  );
}

function words(x: number, y: number): number {
  return ((x & 0xffff) | ((y & 0xffff) << 16)) >>> 0;
}

/** Selected host conversion from DOM wheel units to signed native WHEEL_DELTA messages. */
export interface AokanaMainWheelTranslator {
  translate(event: WheelEvent): readonly {
    readonly axis: 'vertical' | 'horizontal';
    readonly delta: number;
  }[];
}

/** Main-canvas physical mouse path. Outside-canvas observation updates state without inventing HWND capture. */
export class AokanaMainMouseInput {
  private disposed = false;
  private observingDocument = false;
  private observedButtons = 0;
  private ownedButtons = 0;

  constructor(
    readonly host: AokanaBrowserMainWindow,
    readonly input: AokanaNativeInput,
    readonly messages: AokanaWindowMessages,
    readonly wheel: AokanaMainWheelTranslator | null = null,
    readonly suppressMouse: ((event: MouseEvent) => boolean) | null = null,
  ) {
    if (
      input.display !== host.display ||
      messages.input !== input ||
      messages.mainTarget() !== 'main'
    )
      throw new Error('Aokana main mouse requires the shared live main-window owners');
    host.surface.addEventListener('mousedown', this.onCanvasDown);
    host.surface.addEventListener('mouseup', this.onCanvasUp);
    host.surface.addEventListener('mousemove', this.onCanvasMove);
    host.surface.addEventListener('mouseleave', this.onCanvasLeave);
    host.surface.addEventListener('contextmenu', this.onContextMenu);
    if (wheel !== null) host.surface.addEventListener('wheel', this.onWheel, {passive: false});
    host.document.addEventListener?.('mousemove', this.onDocumentMouse);
  }

  private live(): boolean {
    return (
      !this.disposed &&
      this.messages.mainTarget() === 'main' &&
      this.host.callbacks.isReady() &&
      this.host.parent.style.visibility !== 'hidden' &&
      this.host.document.visibilityState !== 'hidden'
    );
  }

  private position(event: MouseEvent): number {
    const point = this.host.mapCanvasViewportPoint(event.clientX, event.clientY);
    this.input.pointerAvailable = true;
    this.input.pointerClientX = point.clientX;
    this.input.pointerClientY = point.clientY;
    this.input.pointerScreenX = point.screenX;
    this.input.pointerScreenY = point.screenY;
    return words(point.clientX, point.clientY);
  }

  private syncObserved(buttons: number): void {
    buttons &= 31;
    const released: number[] = [];
    for (const button of BUTTONS) {
      if ((this.observedButtons & button.bit) !== 0 && (buttons & button.bit) === 0) {
        released.push(button.key);
        this.ownedButtons &= ~button.bit;
      } else if ((this.observedButtons & button.bit) === 0 && (buttons & button.bit) !== 0)
        this.input.setPhysicalKey(button.key, true);
    }
    if (released.length !== 0) this.messages.releasePhysicalKeys(released);
    this.observedButtons = buttons;
    if (buttons === 0) this.stopDocumentObservation();
    else this.startDocumentObservation();
  }

  private readonly onCanvasDown = (event: MouseEvent): void => {
    if (!this.live() || this.suppressMouse?.(event)) return;
    const button = BUTTONS.find((entry) => entry.dom === event.button);
    if (button === undefined) return;
    const lParam = this.position(event),
      buttons = ((event.buttons & 31) | button.bit) >>> 0;
    this.syncObserved((buttons & ~button.bit) | (this.observedButtons & button.bit));
    this.host.focus();
    const message = event.detail > 0 && event.detail % 2 === 0 ? button.double : button.down;
    this.messages.enqueuePhysicalTransitions(
      {
        target: 'main',
        message,
        wParam:
          mouseFlags(buttons, event.shiftKey, event.ctrlKey) |
          (button.bit === 8 ? 0x10000 : button.bit === 16 ? 0x20000 : 0),
        lParam,
      },
      [{key: button.key, down: true}],
    );
    this.observedButtons = buttons;
    this.ownedButtons |= button.bit;
    this.startDocumentObservation();
    event.preventDefault();
  };

  private readonly onCanvasUp = (event: MouseEvent): void => {
    if (!this.live() || this.suppressMouse?.(event)) return;
    const button = BUTTONS.find((entry) => entry.dom === event.button);
    if (button === undefined) return;
    const lParam = this.position(event),
      buttons = event.buttons & 31 & ~button.bit;
    this.syncObserved(buttons | button.bit);
    this.messages.enqueuePhysicalTransitions(
      {
        target: 'main',
        message: button.up,
        wParam:
          mouseFlags(buttons, event.shiftKey, event.ctrlKey) |
          (button.bit === 8 ? 0x10000 : button.bit === 16 ? 0x20000 : 0),
        lParam,
      },
      [{key: button.key, down: false}],
    );
    this.observedButtons = buttons;
    this.ownedButtons &= ~button.bit;
    if (buttons === 0) this.stopDocumentObservation();
    event.preventDefault();
  };

  private readonly onCanvasMove = (event: MouseEvent): void => {
    if (!this.live() || this.suppressMouse?.(event)) return;
    const lParam = this.position(event),
      buttons = event.buttons & 31;
    this.syncObserved(buttons);
    this.messages.enqueuePhysicalMouseMove(
      mouseFlags(buttons, event.shiftKey, event.ctrlKey),
      lParam,
    );
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    if (this.live()) event.preventDefault();
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.live() || this.wheel === null || this.suppressMouse?.(event)) return;
    event.preventDefault();
    this.position(event);
    this.syncObserved(event.buttons & 31);
    const transitions = this.wheel.translate(event);
    for (const transition of transitions) {
      if (
        (transition.axis !== 'vertical' && transition.axis !== 'horizontal') ||
        !Number.isInteger(transition.delta) ||
        transition.delta === 0 ||
        transition.delta < -0x8000 ||
        transition.delta > 0x7fff
      )
        throw new RangeError('Aokana wheel translator requires signed native wheel deltas');
    }
    if (transitions.length === 0) return;
    const lParam = words(this.input.pointerScreenX, this.input.pointerScreenY),
      flags = mouseFlags(event.buttons & 31, event.shiftKey, event.ctrlKey);
    for (const transition of transitions)
      this.messages.enqueuePhysicalTransitions(
        {
          target: 'main',
          message: transition.axis === 'vertical' ? 0x20a : 0x20e,
          wParam: (((transition.delta & 0xffff) << 16) | flags) >>> 0,
          lParam,
        },
        [],
      );
  };

  private readonly onCanvasLeave = (event: MouseEvent): void => {
    if (this.live() && !this.suppressMouse?.(event)) this.position(event);
  };

  private readonly onDocumentMouse = (event: MouseEvent): void => {
    if (event.target === this.host.surface) return;
    if (this.suppressMouse?.(event)) return;
    if (!this.live()) {
      this.deactivate();
      return;
    }
    this.position(event);
    if (this.observedButtons !== 0) this.syncObserved(event.buttons & 31);
  };

  private readonly onDocumentLeave = (): void => {
    this.deactivate();
  };

  private startDocumentObservation(): void {
    if (this.observingDocument) return;
    this.observingDocument = true;
    for (const name of ['mousedown', 'mouseup'] as const)
      this.host.document.addEventListener?.(name, this.onDocumentMouse);
    this.host.document.addEventListener?.('mouseleave', this.onDocumentLeave);
  }

  private stopDocumentObservation(): void {
    if (!this.observingDocument) return;
    this.observingDocument = false;
    for (const name of ['mousedown', 'mouseup'] as const)
      this.host.document.removeEventListener?.(name, this.onDocumentMouse);
    this.host.document.removeEventListener?.('mouseleave', this.onDocumentLeave);
  }

  deactivate(): void {
    if (this.observedButtons !== 0) {
      this.messages.releasePhysicalKeys(
        BUTTONS.filter((button) => (this.observedButtons & button.bit) !== 0).map(
          (button) => button.key,
        ),
      );
    }
    this.observedButtons = this.ownedButtons = 0;
    this.stopDocumentObservation();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.deactivate();
    this.host.surface.removeEventListener('mousedown', this.onCanvasDown);
    this.host.surface.removeEventListener('mouseup', this.onCanvasUp);
    this.host.surface.removeEventListener('mousemove', this.onCanvasMove);
    this.host.surface.removeEventListener('mouseleave', this.onCanvasLeave);
    this.host.surface.removeEventListener('contextmenu', this.onContextMenu);
    if (this.wheel !== null) this.host.surface.removeEventListener('wheel', this.onWheel);
    this.host.document.removeEventListener?.('mousemove', this.onDocumentMouse);
  }
}

import type {AokanaDisplayDevice} from './display-device.js';
import type {AokanaEngineInitializedState} from './engine-initialized-state.js';
import type {AokanaWindowMessages as AokanaWaitWindowMessages} from './procedure.js';
import type {
  AokanaPumpWindowEvent,
  AokanaWindowMessage,
  AokanaWindowMessages,
} from './window-messages.js';

/** The main HWND's awaited WM_PAINT lower; initialized presentation still needs its MF owner. */
export class AokanaQueuedMainPaint {
  constructor(
    readonly messages: AokanaWindowMessages,
    readonly waits: AokanaWaitWindowMessages,
    readonly initialized: AokanaEngineInitializedState,
    readonly device: AokanaDisplayDevice,
  ) {}

  async dispatch(message: AokanaWindowMessage): Promise<0> {
    if (message.target !== 'main' || message.message !== 0xf)
      throw new Error('Aokana main paint requires main WM_PAINT');
    try {
      this.waits.dispatch(
        message.message,
        BigInt.asUintN(64, BigInt(message.wParam)),
        BigInt.asUintN(64, BigInt(message.lParam)),
      );
      this.messages.validatePaint(message);
      const display = this.device.display;
      if (display.presentationEnabled === 0 || display.ordinaryPresentationEnabled === 0) return 0;
      if (this.initialized.initialized)
        throw new Error('Aokana initialized WM_PAINT requires the unselected frame/MF paint owner');
      this.device.clearWindowClient();
      return 0;
    } catch (error) {
      this.messages.releasePaint(message);
      throw error;
    }
  }
}

export interface AokanaQueuedWindowDispatchResult {
  readonly event: AokanaPumpWindowEvent;
  /** A removed quit requests the native negative pump result. */
  readonly result: number | bigint;
}

/** One awaited dequeue route for the shared main and numeric HWND FIFO. */
export class AokanaQueuedWindowDispatcher {
  private closed = false;
  private inFlight: Promise<AokanaQueuedWindowDispatchResult> | null = null;

  constructor(
    readonly messages: AokanaWindowMessages,
    readonly paint: AokanaQueuedMainPaint,
  ) {
    if (paint.messages !== messages)
      throw new Error('Aokana queued dispatcher requires the shared paint queue');
  }

  get hasPendingDispatch(): boolean {
    return this.inFlight !== null;
  }

  dispatchNext(): Promise<AokanaQueuedWindowDispatchResult | null> {
    if (this.closed) throw new Error('Aokana queued dispatch admission is closed');
    if (this.inFlight !== null) throw new Error('Aokana queued dispatch is already in progress');
    const event = this.messages.takePumpEvent();
    if (event === null) return Promise.resolve(null);
    const work = (async (): Promise<AokanaQueuedWindowDispatchResult> => {
      if (event.kind === 'quit') return {event, result: -1};
      const message = event.message;
      if (message.target === 'main') {
        if (!this.messages.hasTarget('main')) {
          this.messages.releasePaint(message);
          return {event, result: 0};
        }
        const result =
          message.message === 0xf
            ? await this.paint.dispatch(message)
            : this.messages.dispatch(message);
        return {event, result};
      }
      try {
        // Numeric WndProc paint enters its BeginPaint-style validation before
        // any awaited owner continuation can request a fresh invalidation.
        if (message.message === 0xf) this.messages.validatePaint(message);
        const handled = await this.messages.dispatchQueuedNumeric(message);
        return {event, result: Number(handled)};
      } catch (error) {
        this.messages.releasePaint(message);
        throw error;
      }
    })();
    this.inFlight = work;
    void work.then(
      () => {
        if (this.inFlight === work) this.inFlight = null;
      },
      () => {
        if (this.inFlight === work) this.inFlight = null;
      },
    );
    return work;
  }

  /** Close admission synchronously, then join the accepted dispatch before HWND teardown. */
  closeAndJoin(): Promise<void> {
    this.closed = true;
    return this.inFlight === null ? Promise.resolve() : this.inFlight.then(() => undefined);
  }
}

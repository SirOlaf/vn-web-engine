import type {BurikoDisplayDevice} from './display-device.js';
import type {BurikoDisplayFrames} from './display-frames.js';
import type {BurikoEngineInitializedState} from './engine-initialized-state.js';
import type {BurikoMainWindowSizeEffects} from './main-window-size-effects.js';
import type {BurikoBrowserMainWindow} from './browser-main-window.js';
import type {BurikoNativeClock} from './clock.js';
import type {BurikoNativeInput} from './input.js';
import type {BurikoMovieRegistry} from './movie-registry.js';
import type {BurikoWindowMessages as BurikoWaitWindowMessages} from './procedure.js';
import type {
  BurikoPumpWindowEvent,
  BurikoWindowMessage,
  BurikoWindowMessages,
} from './window-messages.js';

/** The main HWND's awaited WM_PAINT lower over the actual device and frame owners. */
export class BurikoQueuedMainPaint {
  constructor(
    readonly messages: BurikoWindowMessages,
    readonly waits: BurikoWaitWindowMessages,
    readonly initialized: BurikoEngineInitializedState,
    readonly device: BurikoDisplayDevice,
    readonly frames: BurikoDisplayFrames | null = null,
  ) {
    if (frames !== null && frames.device !== device)
      throw new Error('Buriko main paint requires the shared display frame owner');
  }

  async dispatch(message: BurikoWindowMessage): Promise<0> {
    if (message.target !== 'main' || message.message !== 0xf)
      throw new Error('Buriko main paint requires main WM_PAINT');
    try {
      this.waits.dispatch(
        message.message,
        BigInt.asUintN(64, BigInt(message.wParam)),
        BigInt.asUintN(64, BigInt(message.lParam)),
      );
      this.messages.validatePaint(message);
      const display = this.device.display;
      if (display.presentationEnabled === 0 || display.ordinaryPresentationEnabled === 0) return 0;
      if (!this.initialized.initialized) {
        this.device.clearWindowClient();
        return 0;
      }
      if (this.frames === null)
        throw new Error('Buriko initialized WM_PAINT requires the shared frame owner');
      const movie = this.frames.fullscreenMovie;
      if (movie.query() === 0) {
        const control = movie.displayControl;
        if (control === null)
          throw new Error('Buriko initialized MF WM_PAINT requires a retained display control');
        control.repaint();
        return 0;
      }
      if (movie.presentationFlag !== 0) return 0;
      if (display.fullscreen !== 0 && display.displayFlag !== 1 && display.modalDepth === 0)
        return 0;
      await this.frames.present(1, null, 0, 0);
      return 0;
    } catch (error) {
      this.messages.releasePaint(message);
      throw error;
    }
  }
}

export interface BurikoQueuedWindowDispatchResult {
  readonly event: BurikoPumpWindowEvent;
  /** A removed quit requests the native negative pump result. */
  readonly result: number | bigint;
}

/** Joined FF770 WM_SIZE route. Synchronous SendMessage does not enter this async owner. */
export class BurikoQueuedMainSize {
  constructor(
    readonly messages: BurikoWindowMessages,
    readonly waits: BurikoWaitWindowMessages,
    readonly initialized: BurikoEngineInitializedState,
    readonly host: BurikoBrowserMainWindow,
    readonly input: BurikoNativeInput,
    readonly effects: BurikoMainWindowSizeEffects,
  ) {
    if (
      messages.input !== input ||
      host.display !== input.display ||
      effects.graph.host !== host ||
      effects.graph.messages !== messages ||
      effects.graph.waits !== waits ||
      effects.graph.initialized !== initialized
    )
      throw new Error('Buriko main size requires the shared window and effect owners');
  }

  async dispatch(message: BurikoWindowMessage): Promise<0> {
    if (message.target !== 'main' || message.message !== 5)
      throw new Error('Buriko main size requires main WM_SIZE');
    const actor = this.effects.graph.allocator.currentActor;
    this.waits.dispatch(
      message.message,
      BigInt.asUintN(64, BigInt(message.wParam)),
      BigInt.asUintN(64, BigInt(message.lParam)),
    );
    const state = typeof message.wParam === 'bigint' ? message.wParam : BigInt(message.wParam);
    if (state === 0n) {
      if (this.initialized.initialized) {
        const dimensions = BigInt.asUintN(64, BigInt(message.lParam));
        await this.effects.runInitializedRestore(
          actor,
          Number(dimensions & 0xffffn),
          Number((dimensions >> 16n) & 0xffffn),
        );
      }
      this.host.applySizeMenuTail(message.wParam, this.input);
    } else if (state === 1n) {
      if (this.initialized.initialized) await this.effects.runInitializedMinimize(actor);
      this.host.applySizeMenuTail(message.wParam, this.input);
    }
    // The scoped browser host has no additional WM_SIZE default action.
    return 0;
  }
}

/** FF770 WM_ACTIVATE, separate from the size branch and scoped IsIconic host state. */
export class BurikoQueuedMainActivation {
  constructor(
    readonly messages: BurikoWindowMessages,
    readonly waits: BurikoWaitWindowMessages,
    readonly initialized: BurikoEngineInitializedState,
    readonly host: BurikoBrowserMainWindow,
    readonly input: BurikoNativeInput,
    readonly clock: BurikoNativeClock,
    readonly movies: BurikoMovieRegistry,
  ) {
    if (messages.input !== input || host.display !== input.display || !input.usesClock(clock))
      throw new Error('Buriko main activation requires the shared window and clock owners');
  }

  async dispatch(message: BurikoWindowMessage): Promise<0> {
    if (message.target !== 'main' || message.message !== 6)
      throw new Error('Buriko main activation requires WM_ACTIVATE');
    this.waits.dispatch(
      message.message,
      BigInt.asUintN(64, BigInt(message.wParam)),
      BigInt.asUintN(64, BigInt(message.lParam)),
    );
    const active = (BigInt(message.wParam) & 0xffffn) !== 0n;
    this.input.windowActivated = Number(active);
    if (active) {
      if (this.initialized.initialized) {
        this.clock.endSuspension();
        await this.movies.resumeAll();
      }
      if (this.input.scriptMinimizeLatch !== 0 && !this.host.isMinimized)
        this.input.scriptMinimizeLatch = 0;
    } else if (this.initialized.initialized) {
      this.clock.beginSuspension(false);
      if (this.clock.pauseOptionEnabled) this.movies.suspendAll();
    }
    return 0;
  }
}

/** One awaited dequeue route for the shared main and numeric HWND FIFO. */
export class BurikoQueuedWindowDispatcher {
  private closed = false;
  private inFlight: Promise<unknown> | null = null;

  constructor(
    readonly messages: BurikoWindowMessages,
    readonly paint: BurikoQueuedMainPaint,
    readonly size: BurikoQueuedMainSize | null = null,
    readonly activation: BurikoQueuedMainActivation | null = null,
  ) {
    if (
      paint.messages !== messages ||
      (size !== null && size.messages !== messages) ||
      (activation !== null && activation.messages !== messages)
    )
      throw new Error('Buriko queued dispatcher requires the shared main queue');
  }

  get hasPendingDispatch(): boolean {
    return this.inFlight !== null;
  }

  /** UpdateWindow dispatches only the main invalid region, leaving the posted FIFO untouched. */
  updateMainWindow(): Promise<0 | null> {
    if (this.closed) throw new Error('Buriko queued dispatch admission is closed');
    if (this.inFlight !== null) throw new Error('Buriko queued dispatch is already in progress');
    if (!this.messages.hasTarget('main')) return Promise.resolve(null);
    const paint = this.messages.takePaint('main');
    if (paint === null) return Promise.resolve(null);
    const work = this.paint.dispatch(paint);
    this.track(work);
    return work;
  }

  private track(work: Promise<unknown>): void {
    this.inFlight = work;
    void work.then(
      () => {
        if (this.inFlight === work) this.inFlight = null;
      },
      () => {
        if (this.inFlight === work) this.inFlight = null;
      },
    );
  }

  /** Await one host-generated synchronous-style transition without consuming posted FIFO. */
  dispatchHostMainTransition(message: BurikoWindowMessage): Promise<0> {
    if (this.closed || this.inFlight !== null || this.messages.mainTarget() === null)
      throw new Error('Buriko main transition requires idle live queued dispatch');
    const work =
      message.message === 5 && this.size !== null
        ? this.size.dispatch(message)
        : message.message === 6 && this.activation !== null
          ? this.activation.dispatch(message)
          : null;
    if (work === null) throw new Error('Buriko unsupported host main transition');
    this.track(work);
    return work;
  }

  dispatchNext(): Promise<BurikoQueuedWindowDispatchResult | null> {
    if (this.closed) throw new Error('Buriko queued dispatch admission is closed');
    if (this.inFlight !== null) throw new Error('Buriko queued dispatch is already in progress');
    const event = this.messages.takePumpEvent();
    if (event === null) return Promise.resolve(null);
    return this.dispatchRemoved(event);
  }

  /** Dispatch an event already removed by the GUI pump's TranslateMessage stage. */
  dispatchRemoved(event: BurikoPumpWindowEvent): Promise<BurikoQueuedWindowDispatchResult> {
    if (this.closed) throw new Error('Buriko queued dispatch admission is closed');
    if (this.inFlight !== null) throw new Error('Buriko queued dispatch is already in progress');
    const work = (async (): Promise<BurikoQueuedWindowDispatchResult> => {
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
            : message.message === 5 && this.size !== null
              ? await this.size.dispatch(message)
              : message.message === 6 && this.activation !== null
                ? await this.activation.dispatch(message)
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
    this.track(work);
    return work;
  }

  /** Close admission synchronously, then join the accepted dispatch before HWND teardown. */
  closeAndJoin(): Promise<void> {
    this.closed = true;
    return this.inFlight === null ? Promise.resolve() : this.inFlight.then(() => undefined);
  }
}

/**
 * The TVP event system (krkrz `base/EventIntf.cpp`, `base/win32/EventImpl.cpp`,
 * `environ/win32/SystemControl.cpp`) and the reporting of uncaught script errors
 * (`TVP_CATCH_AND_SHOW_SCRIPT_EXCEPTION`, `TVPProcessUnhandledException`,
 * `TVPShowScriptException` in `base/ScriptMgnIntf.cpp`).
 *
 * Script events wait in a queue and are delivered by `deliverAllEvents`, which the message
 * loop calls from a posted task, from the 50 ms system watch timer and, while continuous
 * handlers exist, on every idle pass. Every delivery is a top-level call: it runs only when no
 * other script runs, and it may suspend (a handler showing a message box); nothing else is
 * delivered until it finishes.
 */
import {closureFuncCall} from '../tjs2/runtime/dispatch.js';
import type {TjsEngine} from '../tjs2/runtime/engine.js';
import {TjsError, TjsScriptError, TjsScriptException, tjsMessage} from '../tjs2/runtime/errors.js';
import {
  TJS_E_BADPARAMCOUNT,
  TJS_IGNOREPROP,
  TJS_MEMBERENSURE,
  TJS_MEMBERMUSTEXIST,
  TJS_S_FALSE,
  TJS_S_OK,
  failed,
  type Dispatch,
} from '../tjs2/runtime/interface.js';
import {VariantSlot, addRefVariant, releaseVariant} from '../tjs2/runtime/slot.js';
import {runRoutine, type SuspendableRoutine} from '../tjs2/runtime/suspension.js';
import {
  asBoolean,
  integer,
  obj,
  str,
  type ObjectVariant,
  type Variant,
} from '../tjs2/runtime/variant.js';
import type {TvpLog} from './log.js';

// TVP_EPT_*: event posting flags.
export const TVP_EPT_POST = 0x00;
export const TVP_EPT_REMOVE_POST = 0x01;
export const TVP_EPT_IMMEDIATE = 0x02;
export const TVP_EPT_DISCARDABLE = 0x10;
export const TVP_EPT_NORMAL = 0x00;
export const TVP_EPT_EXCLUSIVE = 0x20;
export const TVP_EPT_IDLE = 0x40;
export const TVP_EPT_PRIO_MASK = 0xe0;
export const TVP_EPT_METHOD_MASK = 0x0f;

// TVP_COMPACT_LEVEL_*.
export const TVP_COMPACT_LEVEL_IDLE = 5;
export const TVP_COMPACT_LEVEL_DEACTIVATE = 10;
export const TVP_COMPACT_LEVEL_MINIMIZE = 15;
export const TVP_COMPACT_LEVEL_MAX = 100;

/** The host's message loop, as the core's main window sees it. */
export interface KirikiriMessageLoop {
  /** Runs `task` in a later host task (a message posted to the main window). */
  post(task: () => void): void;
  /**
   * Runs `task` at the next idle pass. While continuous handlers exist the core asks for one
   * pass after another (natively a busy idle loop); the host paces them, in a browser to
   * animation frames.
   */
  idle(task: () => void): void;
  /** Calls `tick` every `interval` milliseconds (`SetTimer`). Returns a function that stops it. */
  every(interval: number, tick: () => void): () => void;
  /** Runs `task` once after `delay` milliseconds (a thread's timed wait). Returns a canceller. */
  after(delay: number, task: () => void): () => void;
}

/** A message loop on host timers: `post` and `idle` as soon as possible. */
export function timerMessageLoop(): KirikiriMessageLoop {
  return {
    post: (task) => void setTimeout(task, 0),
    idle: (task) => void setTimeout(task, 0),
    every: (interval, tick) => {
      const id = setInterval(tick, interval);
      return () => clearInterval(id);
    },
    after: (delay, task) => {
      const id = setTimeout(task, delay);
      return () => clearTimeout(id);
    },
  };
}

/** `tTVPBaseInputEvent`: an event from the platform (input, window state, activation). */
export interface TvpInputEvent {
  /** What posted it, for cancellation (`GetSource`). */
  readonly source: unknown;
  readonly tag: unknown;
  /** Delivers the event; may call script and suspend. */
  deliver(): number;
}

/** `tTVPContinuousEventCallbackIntf`. */
export interface TvpContinuousEventCallback {
  onContinuousCallback(tick: bigint): number;
}

/** `tTVPCompactEventCallbackIntf`. */
export interface TvpCompactEventCallback {
  onCompact(level: number): void;
}

/** A window whose content is redrawn by window update events (`tTJSNI_BaseWindow`). */
export interface TvpUpdatableWindow {
  updateContent(): number;
}

/** Raised by `System.exit` and fatal errors: the process ends (`exit(code)`). */
export class TvpProcessExit extends Error {
  constructor(readonly code: number) {
    super(`The core exited with code ${code}`);
    this.name = 'TvpProcessExit';
  }
}

/** What the event system uses of the core and the platform. */
export interface TvpEventServices {
  readonly engine: TjsEngine;
  readonly log: TvpLog;
  readonly loop: KirikiriMessageLoop;
  /** `TVPGetTickCount`: milliseconds. */
  tickCount(): number;
  /** `-contfreq`: the continuous handler frequency limit in Hz, 0 for none. */
  continuousFrequency(): number;
  /**
   * `Application->MessageDlg(text, caption, mtError/mtStop, mbOK)` for an uncaught script
   * error. The core waits for it to close.
   */
  showError(text: string, caption: string): Promise<void>;
  /** `Application->GetTitle()`. */
  title(): string;
  /** `TVPTerminateAsync`: ends the application after the current call. */
  terminate(code: number): void;
  /** `TVPTerminateSync`: uninitializes the core and ends the process. */
  exit(code: number): never;
  /** True after `TVPSystemUninit` (errors are no longer shown). */
  uninitialized(): boolean;
}

/** `tTVPEvent`: a script event; holds references on its target and source. */
class ScriptEvent {
  readonly args: VariantSlot[];
  constructor(
    readonly target: Dispatch,
    readonly source: Dispatch,
    readonly name: string,
    readonly tag: number,
    readonly flags: number,
    readonly sequence: bigint,
    args: readonly Variant[],
  ) {
    target.addRef();
    source.addRef();
    this.args = args.map((a) => new VariantSlot(a));
  }

  /** Skipped when the target was invalidated. */
  deliver(): number {
    if (this.target.isValid(0, null, this.target) === TJS_S_FALSE) return TJS_S_OK;
    return this.target.funcCall(
      0,
      this.name,
      null,
      this.args.map((a) => a.value),
      this.target,
    );
  }

  dispose(): void {
    for (const a of this.args) a.clear();
    this.target.release();
    this.source.release();
  }

  matches(source: Dispatch, target: Dispatch, name: string, tag: number): boolean {
    return (
      this.source === source &&
      this.target === target &&
      this.name === name &&
      (tag === 0 || tag === this.tag)
    );
  }
}

export class TvpEventSystem {
  readonly #services: TvpEventServices;
  #queue: ScriptEvent[] = [];
  #inputQueue: TvpInputEvent[] = [];
  #windowUpdates: (TvpUpdatableWindow | null)[] = [];
  #windowUpdatesDelivering = false;
  #exclusivePosted = false;
  #sequence = 0n;
  #sequenceToProcess = 0n;
  /** `TVPEventDisabled`: set while breathing. */
  eventDisabled = false;
  #interrupting = false;
  #invoked = false;

  #continuousHooks: (TvpContinuousEventCallback | null)[] = [];
  #continuousHandlers: (ObjectVariant | null)[] = [];
  #continuousProcessing = false;
  #processContinuousFlag = false;
  #compactHooks: (TvpCompactEventCallback | null)[] = [];

  // tTVPSystemControl
  #eventEnabled = true;
  #continuousCalling = false;
  #continuousLimit: {interval: number; next: number; stop: () => void} | null = null;
  #lastCompactedTick = 0;
  #lastRehashedTick = 0;
  #stopWatch: (() => void) | null = null;
  #onRehash: () => void;

  /** Top-level calls in order: each waits for the previous one to finish. */
  #topLevel: Promise<unknown> = Promise.resolve();
  #topLevelBusy = false;
  #deliveryPosted = false;
  #idlePosted = false;
  #stopped = false;

  constructor(services: TvpEventServices, onRehash: () => void) {
    this.#services = services;
    this.#onRehash = onRehash;
  }

  get #suspender() {
    return this.#services.engine.suspender;
  }

  // --- top-level calls ----------------------------------------------------------------------

  /**
   * Runs a top-level call (start-up, an event delivery) after the ones before it. Errors not
   * handled inside reject the returned promise.
   */
  runTopLevel(start: () => number): Promise<number> {
    const run = this.#topLevel.then(async () => {
      this.#topLevelBusy = true;
      try {
        return await this.#suspender.run(start);
      } finally {
        this.#topLevelBusy = false;
      }
    });
    this.#topLevel = run.catch(() => {});
    return run;
  }

  /** True while a top-level call runs or waits. */
  get busy(): boolean {
    return this.#topLevelBusy;
  }

  /**
   * Starts the system watch timer (`tTVPSystemControl`): every 50 ms events are delivered,
   * after 4 s without continuous handlers a compact event fires, every 1.5 s object hash
   * tables are rehashed.
   */
  start(): void {
    if (this.#stopWatch) return;
    this.#stopWatch = this.#services.loop.every(50, () => this.#systemWatchTimer());
  }

  /** Stops delivering events (shutdown, termination). */
  stop(): void {
    this.#stopped = true;
    this.#stopWatch?.();
    this.#stopWatch = null;
    this.#continuousLimit?.stop();
    this.#continuousLimit = null;
  }

  #systemWatchTimer(): void {
    if (this.#stopped) return;
    const tick = this.#services.tickCount() >>> 0;
    this.#deliverEventsTask();
    if (!this.#continuousCalling && (tick - this.#lastCompactedTick) >>> 0 > 4000) {
      this.#lastCompactedTick = tick;
      this.#schedule(() => this.deliverCompactEvent(TVP_COMPACT_LEVEL_IDLE));
    }
    if (!this.#continuousCalling && tick > this.#lastRehashedTick + 1500) {
      this.#lastRehashedTick = tick;
      this.#onRehash();
    }
  }

  /** Runs `routine` as a top-level call, reporting what escapes it to the host. */
  #schedule(start: () => number): void {
    void this.runTopLevel(start).catch((error: unknown) => this.#fatal(error));
  }

  #fatal(error: unknown): void {
    if (error instanceof TvpProcessExit) return;
    this.stop();
    queueMicrotask(() => {
      throw error;
    });
  }

  /** `tTVPSystemControl::DeliverEvents`, as a host task. */
  #deliverEventsTask(): void {
    if (this.#stopped || this.#topLevelBusy) return;
    if (this.#continuousCalling) this.#processContinuousFlag = true;
    if (!this.#eventEnabled) return;
    this.#schedule(() => this.deliverAllEvents());
  }

  /** `TVPInvokeEvents` → `CallDeliverAllEventsOnIdle`: posts a delivery. */
  invokeEvents(): void {
    if (this.#invoked) return;
    this.#invoked = true;
    this.#postDelivery();
  }

  #postDelivery(): void {
    if (this.#deliveryPosted || this.#stopped) return;
    this.#deliveryPosted = true;
    this.#services.loop.post(() => {
      this.#deliveryPosted = false;
      this.#deliverEventsTask();
      // A delivery requested while a call ran is retried once it has finished.
      if (this.#invoked) void this.#topLevel.then(() => this.#invoked && this.#postDelivery());
    });
  }

  /** `ApplicationIdle` while continuous calling: one idle pass after another. */
  #postIdle(): void {
    if (this.#idlePosted || this.#stopped || !this.#continuousCalling) return;
    this.#idlePosted = true;
    this.#services.loop.idle(() => {
      this.#idlePosted = false;
      this.#deliverEventsTask();
      void this.#topLevel.then(() => this.#postIdle());
    });
  }

  // --- script events ----------------------------------------------------------------------

  /** `TVPGetSystemEventDisabledState`. */
  get systemEventDisabled(): boolean {
    return !this.#eventEnabled;
  }

  /**
   * `TVPSetSystemEventDisabledState`: enabling delivers the pending events at once (from inside
   * the calling script). Returns a result code; may suspend.
   */
  setSystemEventDisabled(disabled: boolean): number {
    this.#eventEnabled = !disabled;
    if (!disabled) return this.deliverAllEvents();
    return TJS_S_OK;
  }

  /** `TVPPostEvent`. Immediate events are delivered now; returns a result code. */
  postEvent(
    source: Dispatch,
    target: Dispatch,
    name: string,
    tag: number,
    flag: number,
    args: readonly Variant[],
  ): number {
    const disabled = this.eventDisabled || this.systemEventDisabled;
    if (flag & TVP_EPT_DISCARDABLE && (this.#interrupting || disabled)) return TJS_S_OK;
    const method = flag & TVP_EPT_METHOD_MASK;
    if (method === TVP_EPT_IMMEDIATE) {
      if (disabled) return TJS_S_OK;
      const event = new ScriptEvent(target, source, name, tag, flag, this.#sequence, args);
      return runRoutine(this.#suspender, this.#catchAndShow('immediate event', event));
    }
    if (method === TVP_EPT_REMOVE_POST) this.cancelEvents(source, target, name, tag);
    this.#queue.push(new ScriptEvent(target, source, name, tag, flag, this.#sequence, args));
    if ((flag & TVP_EPT_PRIO_MASK) === TVP_EPT_EXCLUSIVE) this.#exclusivePosted = true;
    this.invokeEvents();
    return TJS_S_OK;
  }

  /**
   * Runs `call` under `TVP_CATCH_AND_SHOW_SCRIPT_EXCEPTION(origin)`; `then` runs after it
   * returned normally. Returns a result code; may suspend.
   */
  guardedCall(origin: string, call: () => number, then?: () => void): number {
    const self = this;
    return runRoutine(
      this.#suspender,
      (function* (): SuspendableRoutine {
        try {
          yield call;
          then?.();
        } catch (error) {
          yield* self.#showUncaught(error, origin);
        }
        return TJS_S_OK;
      })(),
    );
  }

  *#catchAndShow(origin: string, event: ScriptEvent): SuspendableRoutine {
    try {
      yield () => event.deliver();
    } catch (error) {
      yield* this.#showUncaught(error, origin);
    } finally {
      event.dispose();
    }
    return TJS_S_OK;
  }

  #removeWhere(pred: (e: ScriptEvent) => boolean): number {
    let count = 0;
    const kept: ScriptEvent[] = [];
    const removed: ScriptEvent[] = [];
    for (const e of this.#queue) (pred(e) ? removed : kept).push(e);
    this.#queue = kept;
    for (const e of removed) {
      e.dispose();
      count++;
    }
    return count;
  }

  /** `TVPCancelEvents`: the number of events removed. */
  cancelEvents(source: Dispatch, target: Dispatch, name: string, tag = 0): number {
    return this.#removeWhere((e) => e.matches(source, target, name, tag));
  }

  /** `TVPAreEventsInQueue`. */
  areEventsInQueue(source: Dispatch, target: Dispatch, name: string, tag = 0): boolean {
    return this.#queue.some((e) => e.matches(source, target, name, tag));
  }

  /** `TVPCountEventsInQueue`. */
  countEventsInQueue(source: Dispatch, target: Dispatch, name: string, tag = 0): number {
    return this.#queue.filter((e) => e.matches(source, target, name, tag)).length;
  }

  /** `TVPCancelEventsByTag`. */
  cancelEventsByTag(source: Dispatch, target: Dispatch, tag = 0): void {
    this.#removeWhere(
      (e) => e.source === source && e.target === target && (tag === 0 || tag === e.tag),
    );
  }

  /** `TVPCancelSourceEvents`. */
  cancelSourceEvents(source: Dispatch): void {
    this.#removeWhere((e) => e.source === source);
  }

  /** `TVPDiscardAllDiscardableEvents`. */
  discardAllDiscardableEvents(): void {
    this.#removeWhere((e) => (e.flags & TVP_EPT_DISCARDABLE) !== 0);
  }

  // --- input events -----------------------------------------------------------------------

  /** `TVPPostInputEvent`. */
  postInputEvent(event: TvpInputEvent, flags: number): void {
    if (flags & TVP_EPT_DISCARDABLE && (this.eventDisabled || this.systemEventDisabled)) return;
    if (flags & TVP_EPT_REMOVE_POST) this.cancelInputEvents(event.source, event.tag);
    this.#inputQueue.push(event);
    this.invokeEvents();
  }

  /** `TVPCancelInputEvents`, of a source or of a source and tag. */
  cancelInputEvents(source: unknown, tag?: unknown): void {
    this.#inputQueue = this.#inputQueue.filter(
      (e) => !(e.source === source && (tag === undefined || e.tag === tag)),
    );
  }

  /** `TVPGetInputEventCount`. */
  get inputEventCount(): number {
    return this.#inputQueue.length;
  }

  // --- window updates ---------------------------------------------------------------------

  /** `TVPPostWindowUpdate`: once per window (twice while updates are being delivered). */
  postWindowUpdate(window: TvpUpdatableWindow): void {
    const count = this.#windowUpdates.filter((w) => w === window).length;
    if (count >= (this.#windowUpdatesDelivering ? 2 : 1)) return;
    this.#windowUpdates.push(window);
    this.invokeEvents();
  }

  /** `TVPRemoveWindowUpdate`. */
  removeWindowUpdate(window: TvpUpdatableWindow): void {
    this.#windowUpdates = this.#windowUpdates.map((w) => (w === window ? null : w));
  }

  *#deliverWindowUpdateEvents(): SuspendableRoutine {
    if (this.#windowUpdatesDelivering) return TJS_S_OK;
    this.#windowUpdatesDelivering = true;
    try {
      for (let i = 0; i < this.#windowUpdates.length; i++) {
        const w = this.#windowUpdates[i];
        if (w) yield () => w.updateContent();
      }
    } finally {
      this.#windowUpdates = [];
      this.#windowUpdatesDelivering = false;
    }
    return TJS_S_OK;
  }

  // --- delivery ---------------------------------------------------------------------------

  *#deliverEventByPrio(prio: number): SuspendableRoutine {
    for (;;) {
      const i = this.#queue.findIndex(
        (e) => e.sequence <= this.#sequenceToProcess && (e.flags & TVP_EPT_PRIO_MASK) === prio,
      );
      if (i < 0) break;
      const e = this.#queue.splice(i, 1)[0]!;
      try {
        yield () => e.deliver();
      } finally {
        e.dispose();
      }
    }
    return TJS_S_OK;
  }

  *#deliverAllEvents2(): SuspendableRoutine {
    this.#exclusivePosted = false;
    yield* this.#deliverEventByPrio(TVP_EPT_EXCLUSIVE);
    if (this.#exclusivePosted) return TJS_S_OK;
    while (this.#inputQueue.length) {
      const e = this.#inputQueue.shift()!;
      yield () => e.deliver();
      if (this.#exclusivePosted) return TJS_S_OK;
    }
    yield* this.#deliverEventByPrio(TVP_EPT_NORMAL);
    return TJS_S_OK;
  }

  /** `TVPDeliverAllEvents`. Returns a result code; may suspend. */
  deliverAllEvents(): number {
    return runRoutine(this.#suspender, this.#deliverAllEvents());
  }

  *#deliverAllEvents(): SuspendableRoutine {
    if (!this.#interrupting) {
      this.#sequenceToProcess = this.#sequence;
      this.#sequence++;
    }
    this.#interrupting = false;
    try {
      if (!this.eventDisabled) {
        // TVPEventReceived
        this.#invoked = false;
        yield* this.#deliverAllEvents2();
      }
    } catch (error) {
      yield* this.#showUncaught(error, 'event');
    }
    if (!this.#exclusivePosted && !this.#interrupting) {
      try {
        yield* this.#deliverEventByPrio(TVP_EPT_IDLE);
      } catch (error) {
        yield* this.#showUncaught(error, 'idle event');
      }
      if (this.#processContinuousFlag) {
        this.#processContinuousFlag = false;
        yield* this.#deliverContinuousEvent();
      }
      try {
        yield* this.#deliverWindowUpdateEvents();
      } catch (error) {
        yield* this.#showUncaught(error, 'window update');
      }
    }
    if (this.#queue.length === 0) this.#sequence = 0n;
    return TJS_S_OK;
  }

  // --- continuous events ------------------------------------------------------------------

  /** `TVPAddContinuousEventHook`. */
  addContinuousEventHook(cb: TvpContinuousEventCallback): void {
    this.#beginContinuousEvent();
    this.#continuousHooks.push(cb);
  }

  /** `TVPRemoveContinuousEventHook`. */
  removeContinuousEventHook(cb: TvpContinuousEventCallback): void {
    this.#continuousHooks = this.#continuousHooks.map((h) => (h === cb ? null : h));
  }

  /** `TVPAddContinuousHandler`: adds a closure once; holds references on it. */
  addContinuousHandler(closure: ObjectVariant): void {
    if (this.#findHandler(closure) >= 0) return;
    this.#beginContinuousEvent();
    const v = obj(closure.object, closure.objthis);
    addRefVariant(v);
    this.#continuousHandlers.push(v);
  }

  /** `TVPRemoveContinuousHandler`: releases the closure; its entry is removed later. */
  removeContinuousHandler(closure: ObjectVariant): void {
    const i = this.#findHandler(closure);
    if (i < 0) return;
    releaseVariant(this.#continuousHandlers[i]!);
    this.#continuousHandlers[i] = null;
  }

  #findHandler(closure: ObjectVariant): number {
    return this.#continuousHandlers.findIndex(
      (h) => h !== null && h.object === closure.object && h.objthis === closure.objthis,
    );
  }

  *#deliverContinuousEvent(): SuspendableRoutine {
    if (this.#continuousProcessing) return TJS_S_OK;
    this.#continuousProcessing = true;
    try {
      yield* this.#deliverContinuousEventInner();
    } catch (error) {
      this.#continuousProcessing = false;
      yield* this.#showUncaught(error, 'continuous event');
    }
    this.#continuousProcessing = false;
    return TJS_S_OK;
  }

  *#deliverContinuousEventInner(): SuspendableRoutine {
    const tick = BigInt(this.#services.tickCount());
    if (this.#continuousHooks.length) {
      let empty = false;
      for (let i = 0; i < this.#continuousHooks.length; i++) {
        const h = this.#continuousHooks[i];
        if (h) yield () => h.onContinuousCallback(tick);
        else empty = true;
        if (this.#exclusivePosted) return TJS_S_OK;
      }
      if (empty) this.#continuousHooks = this.#continuousHooks.filter((h) => h !== null);
    }
    if (!this.eventDisabled && this.#continuousHandlers.length) {
      let empty = false;
      const vtick = integer(tick);
      for (let i = 0; i < this.#continuousHandlers.length; i++) {
        const h = this.#continuousHandlers[i];
        if (!h) {
          empty = true;
          continue;
        }
        let er: number;
        try {
          er = yield () => closureFuncCall(h, 0, null, null, [vtick], null);
        } catch (error) {
          this.#dropHandler(h);
          throw error;
        }
        if (failed(er)) {
          this.#dropHandler(h);
          empty = true;
        }
        if (this.#exclusivePosted) return TJS_S_OK;
      }
      if (empty) this.#continuousHandlers = this.#continuousHandlers.filter((h) => h !== null);
    }
    if (!this.#continuousHooks.length && !this.#continuousHandlers.length)
      this.#endContinuousEvent();
    return TJS_S_OK;
  }

  #dropHandler(h: ObjectVariant): void {
    const i = this.#continuousHandlers.indexOf(h);
    if (i < 0) return;
    releaseVariant(h);
    this.#continuousHandlers[i] = null;
  }

  /**
   * `TVPBeginContinuousEvent`: without `-contfreq` the core calls continuous handlers on every
   * idle pass; with it, a limiter flags a call at that frequency.
   */
  #beginContinuousEvent(): void {
    const freq = this.#services.continuousFrequency();
    if (freq === 0) {
      if (!this.#continuousCalling) {
        this.#continuousCalling = true;
        this.invokeEvents();
        this.#postIdle();
      }
    } else if (!this.#continuousLimit) {
      const interval = 1000 / freq;
      const limit = {interval, next: 0, stop: () => {}};
      const now = this.#services.tickCount();
      limit.next = Math.floor((now + 1) / interval) * interval;
      // The limiter thread wakes at the next tick due and posts a delivery.
      limit.stop = this.#services.loop.every(Math.max(1, Math.floor(interval)), () => {
        const t = this.#services.tickCount();
        if (limit.next > t) return;
        this.#processContinuousFlag = true;
        while (limit.next <= t) limit.next += interval;
        this.#postDelivery();
      });
      this.#continuousLimit = limit;
    }
  }

  /** `TVPEndContinuousEvent`. */
  #endContinuousEvent(): void {
    this.#continuousLimit?.stop();
    this.#continuousLimit = null;
    this.#continuousCalling = false;
  }

  // --- compact events ---------------------------------------------------------------------

  /** `TVPAddCompactEventHook`. */
  addCompactEventHook(cb: TvpCompactEventCallback): void {
    this.#compactHooks.push(cb);
  }

  /** `TVPRemoveCompactEventHook`. */
  removeCompactEventHook(cb: TvpCompactEventCallback): void {
    this.#compactHooks = this.#compactHooks.map((h) => (h === cb ? null : h));
  }

  /** `TVPDeliverCompactEvent`: a failing hook's error is shown. Returns a result code. */
  deliverCompactEvent(level: number): number {
    return runRoutine(this.#suspender, this.#deliverCompactEvent(level));
  }

  *#deliverCompactEvent(level: number): SuspendableRoutine {
    let empty = false;
    for (let i = 0; i < this.#compactHooks.length; i++) {
      const h = this.#compactHooks[i];
      if (!h) {
        empty = true;
        continue;
      }
      try {
        h.onCompact(level);
      } catch (error) {
        yield* this.#showScriptException(this.#asTjsError(error), 'Compact Event');
      }
    }
    if (empty) this.#compactHooks = this.#compactHooks.filter((h) => h !== null);
    return TJS_S_OK;
  }

  // --- uncaught errors --------------------------------------------------------------------

  /** `TJS_CONVERT_TO_TJS_EXCEPTION`: host errors other than TJS errors pass through. */
  #asTjsError(error: unknown): TjsError {
    if (error instanceof TjsError) return error;
    throw error;
  }

  /**
   * `TVP_CATCH_AND_SHOW_SCRIPT_EXCEPTION(origin)`: script errors get `origin` added to their
   * trace and go to `System.exceptionHandler`; when it does not handle them they are shown
   * and the core ends.
   */
  *#showUncaught(error: unknown, origin: string): SuspendableRoutine {
    const e = this.#asTjsError(error);
    if (e instanceof TjsScriptError) e.addTrace(origin);
    const handled = yield* this.#processUnhandledException(e);
    if (!handled) yield* this.#showScriptException(e);
    return TJS_S_OK;
  }

  /** `TVPProcessUnhandledException`: true when `System.exceptionHandler` returned true. */
  *#processUnhandledException(e: TjsError): Generator<() => number, boolean, number> {
    const {engine} = this.#services;
    const handler = this.#exceptionHandler();
    if (!handler) {
      if (e instanceof TjsScriptException) releaseVariant(e.value);
      return false;
    }
    const res = new VariantSlot();
    let arg: Variant;
    if (e instanceof TjsScriptException) arg = e.value;
    else arg = engine.exceptionObject(e.message, e instanceof TjsScriptError ? e.trace : undefined);
    try {
      yield () => closureFuncCall(handler, 0, null, res, [arg], null);
      return asBoolean(res.value);
    } catch (inner) {
      yield* this.#showScriptException(this.#asTjsError(inner));
      return false;
    } finally {
      releaseVariant(arg);
      res.clear();
      releaseVariant(handler);
    }
  }

  /** `TJSGetSystem_exceptionHandler_Object`: the handler closure with references, or null. */
  #exceptionHandler(): ObjectVariant | null {
    const {global} = this.#services.engine;
    const system = new VariantSlot();
    const handler = new VariantSlot();
    try {
      if (failed(global.propGet(TJS_MEMBERMUSTEXIST, 'System', system, global))) return null;
      const s = system.value;
      if (s.type !== 1 || !s.object) return null;
      s.object.propGet(TJS_MEMBERMUSTEXIST, 'exceptionHandler', handler, s.objthis ?? s.object);
      const h = handler.value;
      if (h.type !== 1 || !h.object) return null;
      return handler.take() as ObjectVariant;
    } finally {
      system.clear();
      handler.clear();
    }
  }

  /**
   * `TVPShowScriptException`: disables events, starts the log file, shows the error and ends
   * the process.
   */
  *#showScriptException(e: TjsError, origin?: string): SuspendableRoutine {
    if (origin !== undefined && e instanceof TjsScriptError) e.addTrace(origin);
    yield () => this.setSystemEventDisabled(true);
    this.#services.log.onError();
    if (this.#services.uninitialized()) return TJS_S_OK;
    const text = tjsMessage('TVPScriptExceptionRaised') + '\n' + e.message;
    this.#services.log.add(text);
    let caption = '';
    if (e instanceof TjsScriptError) {
      if (e.trace.length) this.#services.log.add('trace : ' + e.trace);
      caption = this.#services.title();
    }
    yield () => this.#suspender.suspend(this.#services.showError(text, caption), () => TJS_S_OK);
    this.#services.exit(1);
  }

  /** Releases queued events and handlers (`TVPDestroyEventQueue` and the at-exit handlers). */
  dispose(): void {
    this.stop();
    for (const e of this.#queue.splice(0)) e.dispose();
    this.#inputQueue = [];
    for (const h of this.#continuousHandlers) if (h) releaseVariant(h);
    this.#continuousHandlers = [];
    this.#continuousHooks = [];
    this.#compactHooks = [];
  }
}

/**
 * `TVPCreateEventObject`: the Dictionary passed to an `action` handler, with `type` and
 * `target` (`targthis` in the context of `targ`). Owned by the caller.
 */
export function createEventObject(
  engine: TjsEngine,
  type: string,
  targthis: Dispatch | null,
  targ: Dispatch | null,
): Dispatch {
  const object = engine.createDictionary();
  object.propSet(TJS_MEMBERENSURE | TJS_IGNOREPROP, 'type', str(type), object);
  object.propSet(TJS_MEMBERENSURE | TJS_IGNOREPROP, 'target', obj(targthis, targ), object);
  return object;
}

/**
 * `TVP_ACTION_INVOKE_BEGIN` … `END_NAME`: calls `name` (the object itself when empty) on
 * `owner` with an event object of `type` for `object`, after setting `members` on it from
 * the arguments in order. Returns a result code; may suspend.
 */
export function invokeAction(
  engine: TjsEngine,
  owner: ObjectVariant,
  name: string,
  type: string,
  object: Dispatch,
  result: VariantSlot | null,
  args: readonly Variant[],
  members: readonly string[] = [],
): number {
  if (args.length < members.length) return TJS_E_BADPARAMCOUNT;
  const evobj = createEventObject(engine, type, object, object);
  const evval = obj(evobj, evobj);
  addRefVariant(evval);
  evobj.release();
  try {
    members.forEach((m, i) => evobj.propSet(TJS_MEMBERENSURE | TJS_IGNOREPROP, m, args[i]!, evobj));
    return closureFuncCall(owner, 0, name === '' ? null : name, result, [evval], null);
  } finally {
    releaseVariant(evval);
  }
}

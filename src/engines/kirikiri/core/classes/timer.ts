/**
 * `Timer` (krkrz `utils/TimerIntf.cpp`, `utils/TimerImpl.cpp`). The timer thread becomes a
 * host timeout scheduled for the earliest due timer; due timers count pending firings, which
 * a posted task turns into `onTimer` events (at most `capacity` queued per timer).
 */
import type {TjsEngine} from '../../tjs2/runtime/engine.js';
import {TJS_E_NATIVECLASSCRASH, TJS_S_OK, type Dispatch} from '../../tjs2/runtime/interface.js';
import {
  NativeClass,
  NativeInstanceBase,
  constructNativeInstance,
  paramExists,
} from '../../tjs2/runtime/native.js';
import {addRefVariant, releaseVariant} from '../../tjs2/runtime/slot.js';
import {
  NULL_OBJECT,
  asBoolean,
  asInt32,
  asObjectClosure,
  asReal,
  asString,
  bool,
  int,
  real,
  type ObjectVariant,
  type Variant,
} from '../../tjs2/runtime/variant.js';
import {
  TVP_EPT_DISCARDABLE,
  TVP_EPT_EXCLUSIVE,
  TVP_EPT_IDLE,
  TVP_EPT_POST,
  invokeAction,
  type KirikiriMessageLoop,
  type TvpEventSystem,
} from '../events.js';
import {ATM_AT_IDLE, ATM_EXCLUSIVE, ATM_NORMAL} from './async-trigger.js';

/** `TVP_SUBMILLI_FRAC_BITS`: intervals and ticks are in 1/65536 ms. */
const SUBMILLI = 65536;
const DEFAULT_CAPACITY = 6;
const LEAST_TIMER_INTERVAL = 3;

/** `tTVPTimerThread`. */
class TimerThread {
  readonly #list: TimerNI[] = [];
  #pending: TimerNI[] = [];
  #pendingPosted = false;
  #cancelWake: (() => void) | null = null;

  constructor(
    private readonly loop: KirikiriMessageLoop,
    private readonly tickCount: () => number,
  ) {}

  now(): number {
    return this.tickCount() * SUBMILLI;
  }

  add(item: TimerNI): void {
    if (!this.#list.includes(item)) this.#list.push(item);
  }

  remove(item: TimerNI): void {
    const i = this.#list.indexOf(item);
    if (i >= 0) this.#list.splice(i, 1);
    this.removeFromPending(item);
    if (!this.#list.length) this.#sleep();
  }

  removeFromPending(item: TimerNI): void {
    this.#pending = this.#pending.filter((t) => t !== item);
    item.pendingCount = 0;
  }

  registerToPending(item: TimerNI): void {
    this.#pending.push(item);
  }

  setEnabled(item: TimerNI, enabled: boolean): void {
    item.enabled = enabled;
    if (enabled) item.nextTick = this.now() + item.interval;
    else {
      item.cancelEvents();
      item.pendingCount = 0;
    }
    if (enabled) this.#wake();
  }

  setInterval(item: TimerNI, interval: number): void {
    item.interval = interval;
    if (item.enabled) {
      item.cancelEvents();
      item.pendingCount = 0;
      item.nextTick = this.now() + item.interval;
      this.#wake();
    }
  }

  #sleep(): void {
    this.#cancelWake?.();
    this.#cancelWake = null;
  }

  /** `Event.Set()`: runs the thread loop now. */
  #wake(): void {
    this.#sleep();
    this.#cancelWake = this.loop.after(0, () => this.#execute());
  }

  /** One pass of `Execute`: triggers due timers, then sleeps until the next one is due. */
  #execute(): void {
    this.#cancelWake = null;
    const curtick = this.now();
    let stepNext = -1;
    let anyTriggered = false;
    for (const item of this.#list) {
      if (!item.enabled || item.interval === 0) continue;
      if (item.nextTick < curtick) {
        const n = Math.floor((curtick - item.nextTick) / item.interval) + 1;
        if (n > 40) {
          item.trigger(1);
          item.nextTick = curtick + item.interval;
        } else {
          item.trigger(n);
          item.nextTick += n * item.interval;
        }
        anyTriggered = true;
      }
      const toNext = item.nextTick - curtick;
      if (stepNext === -1 || stepNext > toNext) stepNext = toNext;
    }
    if (anyTriggered && !this.#pendingPosted) {
      this.#pendingPosted = true;
      this.loop.post(() => this.#proc());
    }
    if (stepNext === -1 || !this.#list.length) return;
    const sleep = Math.max(
      LEAST_TIMER_INTERVAL,
      Math.ceil(Math.min(stepNext, 0x7fffffff) / SUBMILLI),
    );
    this.#cancelWake = this.loop.after(sleep, () => this.#execute());
  }

  /** `Proc(TVP_EV_TIMER_THREAD)`: turns pending firings into events. */
  #proc(): void {
    const pending = this.#pending;
    this.#pending = [];
    for (const item of pending) item.firePendingEventsAndClear();
    this.#pendingPosted = false;
  }
}

/** `tTJSNI_Timer` with `tTJSNI_BaseTimer`. */
class TimerNI extends NativeInstanceBase {
  owner: Dispatch | null = null;
  actionOwner: ObjectVariant = NULL_OBJECT;
  actionName = 'action';
  counter = 0;
  capacity = DEFAULT_CAPACITY;
  mode = ATM_NORMAL;
  nextTick = 0;
  /** Sub-milliseconds; 1000 by default, as natively (not one second). */
  interval = 1000;
  pendingCount = 0;
  enabled = false;

  constructor(
    private readonly events: TvpEventSystem,
    private readonly thread: TimerThread,
    private readonly limitCapacity: () => boolean,
  ) {
    super();
  }

  /** The base class's result is ignored: `new Timer()` succeeds, without an owner. */
  override construct(args: readonly Variant[], owner: Dispatch): number {
    if (args.length >= 1) {
      if (paramExists(args, 1)) this.actionName = asString(args[1]!);
      const closure = asObjectClosure(args[0]!);
      addRefVariant(closure);
      this.actionOwner = closure;
      this.owner = owner;
    }
    this.thread.add(this);
    return TJS_S_OK;
  }

  override invalidate(): void {
    this.thread.remove(this);
    this.pendingCount = 0;
    this.cancelEvents();
    if (this.owner) this.events.cancelSourceEvents(this.owner);
    this.owner = null;
    releaseVariant(this.actionOwner);
    this.actionOwner = NULL_OBJECT;
  }

  trigger(n: number): void {
    if (this.pendingCount === 0) this.thread.registerToPending(this);
    this.pendingCount += n;
  }

  firePendingEventsAndClear(): void {
    if (!this.pendingCount) return;
    this.fire(this.pendingCount);
    this.pendingCount = 0;
  }

  /** `Fire`: queues up to the capacity left; tags carry the firing counter. */
  fire(n: number): void {
    const owner = this.owner;
    if (!owner) return;
    const count = this.events.countEventsInQueue(owner, owner, 'onTimer', 0);
    const cap = this.limitCapacity() ? 1 : this.capacity === 0 ? 65535 : this.capacity;
    const more = cap - count;
    if (more <= 0) return;
    if (n > more) n = more;
    const tag = (1 + (this.counter << 1)) >>> 0;
    let flags = TVP_EPT_POST | TVP_EPT_DISCARDABLE;
    if (this.mode === ATM_EXCLUSIVE) flags |= TVP_EPT_EXCLUSIVE;
    if (this.mode === ATM_AT_IDLE) flags |= TVP_EPT_IDLE;
    while (n--) this.events.postEvent(owner, owner, 'onTimer', tag, flags, []);
    this.counter = (this.counter + 1) | 0;
  }

  cancelEvents(): void {
    if (this.owner) this.events.cancelEvents(this.owner, this.owner, 'onTimer', 0);
  }
}

export function createTimerClass(
  engine: TjsEngine,
  events: TvpEventSystem,
  loop: KirikiriMessageLoop,
  tickCount: () => number,
  getArgument: (name: string) => string | null,
): NativeClass {
  const thread = new TimerThread(loop, tickCount);
  // `-laxtimer=yes` limits every timer to one queued event.
  const limitCapacity = getArgument('-laxtimer') === 'yes';
  const cls = new NativeClass('Timer', () => new TimerNI(events, thread, () => limitCapacity));
  const get = (objthis: Dispatch) => cls.instanceOf<TimerNI>(objthis);
  const prop = (read: (ni: TimerNI) => Variant, write: (ni: TimerNI, value: Variant) => void) => ({
    get: (result: {set(v: Variant): void}, objthis: Dispatch) => {
      const ni = get(objthis);
      if (!ni) return TJS_E_NATIVECLASSCRASH;
      result.set(read(ni));
      return TJS_S_OK;
    },
    set: (value: Variant, objthis: Dispatch) => {
      const ni = get(objthis);
      if (!ni) return TJS_E_NATIVECLASSCRASH;
      write(ni, value);
      return TJS_S_OK;
    },
  });
  cls.emptyFinalize();
  cls.constructorMethod((_result, args, objthis) => {
    const r = constructNativeInstance(cls, args, objthis);
    return typeof r === 'number' ? r : TJS_S_OK;
  });
  cls.method('onTimer', (result, args, objthis) => {
    const ni = get(objthis);
    if (!ni) return TJS_E_NATIVECLASSCRASH;
    if (!ni.actionOwner.object) return TJS_S_OK;
    return invokeAction(engine, ni.actionOwner, ni.actionName, 'onTimer', objthis, result, args);
  });
  cls.property(
    'interval',
    prop(
      (ni) => real(ni.interval / SUBMILLI),
      (ni, v) => thread.setInterval(ni, Math.trunc(asReal(v) * SUBMILLI + 0.5)),
    ),
  );
  cls.property(
    'enabled',
    prop(
      (ni) => bool(ni.enabled),
      (ni, v) => thread.setEnabled(ni, asBoolean(v)),
    ),
  );
  cls.property(
    'capacity',
    prop(
      (ni) => int(ni.capacity),
      (ni, v) => void (ni.capacity = asInt32(v)),
    ),
  );
  cls.property(
    'mode',
    prop(
      (ni) => int(ni.mode),
      (ni, v) => void (ni.mode = asInt32(v)),
    ),
  );
  return cls;
}

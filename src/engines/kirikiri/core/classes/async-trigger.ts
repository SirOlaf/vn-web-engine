/** `AsyncTrigger` (krkrz `base/EventIntf.cpp`, `tTJSNC_AsyncTrigger`). */
import type {TjsEngine} from '../../tjs2/runtime/engine.js';
import {
  TJS_E_BADPARAMCOUNT,
  TJS_E_NATIVECLASSCRASH,
  TJS_S_OK,
  type Dispatch,
} from '../../tjs2/runtime/interface.js';
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
  asString,
  bool,
  int,
  type ObjectVariant,
  type Variant,
} from '../../tjs2/runtime/variant.js';
import {
  TVP_EPT_EXCLUSIVE,
  TVP_EPT_IDLE,
  TVP_EPT_POST,
  invokeAction,
  type TvpEventSystem,
} from '../events.js';

/** `tTVPAsyncTriggerMode`. */
export const ATM_NORMAL = 0;
export const ATM_EXCLUSIVE = 1;
export const ATM_AT_IDLE = 2;

/** `tTJSNI_AsyncTrigger`. */
class AsyncTriggerNI extends NativeInstanceBase {
  owner: Dispatch | null = null;
  actionOwner: ObjectVariant = NULL_OBJECT;
  actionName = 'action';
  cached = true;
  mode = ATM_NORMAL;

  constructor(private readonly events: TvpEventSystem) {
    super();
  }

  override construct(args: readonly Variant[], owner: Dispatch): number {
    if (args.length < 1) return TJS_E_BADPARAMCOUNT;
    if (paramExists(args, 1)) this.actionName = asString(args[1]!);
    const closure = asObjectClosure(args[0]!);
    addRefVariant(closure);
    this.actionOwner = closure;
    this.owner = owner;
    return TJS_S_OK;
  }

  override invalidate(): void {
    if (this.owner) this.events.cancelSourceEvents(this.owner);
    this.owner = null;
    releaseVariant(this.actionOwner);
    this.actionOwner = NULL_OBJECT;
  }

  trigger(): number {
    if (!this.owner) return TJS_S_OK;
    if (this.cached) this.events.cancelSourceEvents(this.owner);
    let flags = TVP_EPT_POST;
    if (this.mode === ATM_EXCLUSIVE) flags |= TVP_EPT_EXCLUSIVE;
    if (this.mode === ATM_AT_IDLE) flags |= TVP_EPT_IDLE;
    return this.events.postEvent(this.owner, this.owner, 'onFire', 0, flags, []);
  }

  cancel(): void {
    if (this.owner) this.events.cancelSourceEvents(this.owner);
  }

  setCached(b: boolean): void {
    if (this.cached === b) return;
    this.cached = b;
    this.cancel();
  }

  setMode(m: number): void {
    if (this.mode === m) return;
    this.mode = m;
    this.cancel();
  }
}

export function createAsyncTriggerClass(engine: TjsEngine, events: TvpEventSystem): NativeClass {
  const cls = new NativeClass('AsyncTrigger', () => new AsyncTriggerNI(events));
  const get = (objthis: Dispatch) => cls.instanceOf<AsyncTriggerNI>(objthis);
  cls.emptyFinalize();
  cls.constructorMethod((_result, args, objthis) => {
    const r = constructNativeInstance(cls, args, objthis);
    return typeof r === 'number' ? r : TJS_S_OK;
  });
  cls.method('trigger', (_result, _args, objthis) => {
    const ni = get(objthis);
    return ni ? ni.trigger() : TJS_E_NATIVECLASSCRASH;
  });
  cls.method('cancel', (_result, _args, objthis) => {
    const ni = get(objthis);
    if (!ni) return TJS_E_NATIVECLASSCRASH;
    ni.cancel();
    return TJS_S_OK;
  });
  cls.method('onFire', (result, args, objthis) => {
    const ni = get(objthis);
    if (!ni) return TJS_E_NATIVECLASSCRASH;
    if (!ni.actionOwner.object) return TJS_S_OK;
    return invokeAction(engine, ni.actionOwner, ni.actionName, 'onFire', objthis, result, args);
  });
  cls.property('cached', {
    get: (result, objthis) => {
      const ni = get(objthis);
      if (!ni) return TJS_E_NATIVECLASSCRASH;
      result.set(bool(ni.cached));
      return TJS_S_OK;
    },
    set: (value, objthis) => {
      const ni = get(objthis);
      if (!ni) return TJS_E_NATIVECLASSCRASH;
      ni.setCached(asBoolean(value));
      return TJS_S_OK;
    },
  });
  cls.property('mode', {
    get: (result, objthis) => {
      const ni = get(objthis);
      if (!ni) return TJS_E_NATIVECLASSCRASH;
      result.set(int(ni.mode));
      return TJS_S_OK;
    },
    set: (value, objthis) => {
      const ni = get(objthis);
      if (!ni) return TJS_E_NATIVECLASSCRASH;
      ni.setMode(asInt32(value));
      return TJS_S_OK;
    },
  });
  return cls;
}

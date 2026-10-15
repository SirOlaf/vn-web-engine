/**
 * The helpers `tp_stub.cpp` and `ncbind` compile into a plugin, on the function exporter:
 * error codes thrown as script exceptions (`TJSThrowFrom_tjs_error`), checked calls
 * (`Try_iTJSDispatch2_*`) and property access on objects and dictionaries
 * (`ncbPropAccessor`, `ncbDictionaryAccessor`).
 */
import {
  failed,
  TJS_E_ACCESSDENYED,
  TJS_E_BADPARAMCOUNT,
  TJS_E_INVALIDOBJECT,
  TJS_E_INVALIDPARAM,
  TJS_E_INVALIDTYPE,
  TJS_E_MEMBERNOTFOUND,
  TJS_E_NATIVECLASSCRASH,
  TJS_E_NOTIMPL,
  TJS_E_SUSPENDED,
  TJS_MEMBERENSURE,
  TJS_MEMBERMUSTEXIST,
  type Dispatch,
  type TvpFunctionExporter,
  type Variant,
  type VariantResult,
} from '../tjs2/runtime/interface.js';
import {VariantSlot} from '../tjs2/runtime/slot.js';
import {deferSuspended} from '../tjs2/runtime/suspension.js';
import {asInteger, int, integer, obj, str, VOID} from '../tjs2/runtime/variant.js';

/** `TJSThrowFrom_tjs_error`: throws the script exception of a failed result code. */
export function throwFromError(
  ex: TvpFunctionExporter,
  hr: number,
  name: string | null = null,
): void {
  const msg = (id: string) => ex.TJSGetMessageMapMessage(id);
  switch (hr) {
    case TJS_E_MEMBERNOTFOUND:
      if (name !== null) ex.TVPThrowExceptionMessage(msg('TJSMemberNotFound'), name);
      ex.TVPThrowExceptionMessage(msg('TJSMemberNotFoundNoNameGiven'));
    case TJS_E_NOTIMPL:
      ex.TVPThrowExceptionMessage(msg('TJSNotImplemented'));
    case TJS_E_INVALIDPARAM:
      ex.TVPThrowExceptionMessage(msg('TJSInvalidParam'));
    case TJS_E_BADPARAMCOUNT:
      ex.TVPThrowExceptionMessage(msg('TJSBadParamCount'));
    case TJS_E_INVALIDTYPE:
      ex.TVPThrowExceptionMessage(msg('TJSInvalidType'));
    case TJS_E_ACCESSDENYED:
      ex.TVPThrowExceptionMessage(msg('TJSAccessDenyed'));
    case TJS_E_INVALIDOBJECT:
      ex.TVPThrowExceptionMessage(msg('TJSInvalidObject'));
    case TJS_E_NATIVECLASSCRASH:
      ex.TVPThrowExceptionMessage(msg('TJSNativeClassCrash'));
    case TJS_E_SUSPENDED:
      // A plugin's native frame cannot be resumed: the script it called had to wait.
      ex.TVPThrowExceptionMessage('A script called from a plugin cannot wait for storage');
    default:
      if (failed(hr))
        ex.TVPThrowExceptionMessage(
          `Unknown failure : ${(hr >>> 0).toString(16).toUpperCase().padStart(8, '0')}`,
        );
  }
}

/** `Try_iTJSDispatch2_FuncCall`. */
export function tryFuncCall(
  ex: TvpFunctionExporter,
  target: Dispatch,
  member: string | null,
  result: VariantSlot | null,
  args: readonly Variant[],
  objthis: Dispatch | null,
): void {
  throwFromError(ex, target.funcCall(0, member, result, args, objthis), member);
}

/** `ncbPropAccessor`: typed member access on an object (or a dictionary). */
export class PropAccessor {
  constructor(
    readonly ex: TvpFunctionExporter,
    readonly target: Dispatch,
  ) {}

  /** `HasValue`: whether the member exists; `type` receives the value's type. */
  hasValue(name: string | number, type?: {value: number}): boolean {
    const slot = new VariantSlot();
    const hr =
      typeof name === 'number'
        ? this.target.propGetByNum(TJS_MEMBERMUSTEXIST, name, slot, this.target)
        : this.target.propGet(TJS_MEMBERMUSTEXIST, name, slot, this.target);
    if (type) type.value = slot.value.type;
    slot.clear();
    return !failed(hr);
  }

  /** `GetValue`: the member, void when missing; the caller owns no reference. */
  getValue(name: string | number): Variant {
    const slot = new VariantSlot();
    const hr =
      typeof name === 'number'
        ? this.target.propGetByNum(0, name, slot, this.target)
        : this.target.propGet(0, name, slot, this.target);
    if (failed(hr)) {
      slot.clear();
      return VOID;
    }
    const v = slot.value;
    slot.clear();
    return v;
  }

  /** `getIntValue`: `(tjs_int)` of the member, 0 when missing. */
  getInt(name: string | number): number {
    const v = this.getValue(name);
    return v.type === 0 ? 0 : Number(BigInt.asIntN(32, asInteger(v)));
  }

  /** `SetValue` with `TJS_MEMBERENSURE`. */
  setValue(name: string | number, value: Variant): void {
    const hr =
      typeof name === 'number'
        ? this.target.propSetByNum(TJS_MEMBERENSURE, name, value, this.target)
        : this.target.propSet(TJS_MEMBERENSURE, name, value, this.target);
    throwFromError(this.ex, hr, typeof name === 'string' ? name : null);
  }

  /** `GetArrayCount` (`count`). */
  count(): number {
    return this.getInt('count');
  }
}

/** `ncbDictionaryAccessor`: a new dictionary to fill; `variant()` hands it out. */
export class DictionaryBuilder {
  readonly dict: Dispatch;

  constructor(readonly ex: TvpFunctionExporter) {
    this.dict = ex.TJSCreateDictionaryObject();
  }

  set(name: string, value: Variant | number | string): this {
    const v =
      typeof value === 'number' ? int(value) : typeof value === 'string' ? str(value) : value;
    this.dict.propSet(TJS_MEMBERENSURE, name, v, this.dict);
    return this;
  }

  /**
   * Stores the dictionary in `result` as `tTJSVariant(dict, dict)` (when given) and releases
   * the builder's reference.
   */
  toResult(result: VariantResult | null): void {
    result?.set(obj(this.dict, this.dict));
    this.dict.release();
  }
}

/**
 * `TVPGetLocallyAccessibleName` as `tp_stub` provides it: `TVPGetLocalName` inside a try block,
 * the empty string when the storage has no local name.
 */
export function getLocallyAccessibleName(ex: TvpFunctionExporter, name: string): string {
  try {
    return ex.TVPGetLocalName(name);
  } catch {
    return '';
  }
}

/** A 64-bit integer variant of a pointer or handle (`(tjs_int64)ptr`). */
export function pointer(value: number): Variant {
  return integer(BigInt(value >>> 0));
}

/**
 * A native routine that calls script or waits for storage, written as a generator: it yields
 * each such call as a function returning a result code and receives the code back (or the
 * thrown error, at the `yield`). Natively the call blocks; here it may suspend.
 */
export type PluginRoutine<T> = Generator<() => number, T, number>;

/**
 * Runs a routine to completion or to its first suspended call, then `done(value)`. A call that
 * returns `TJS_E_SUSPENDED` defers the rest of the routine behind it, so a plugin method can
 * return this function's code directly.
 */
export function runPluginRoutine<T>(routine: PluginRoutine<T>, done: (value: T) => number): number {
  const step = (s: IteratorResult<() => number, T>): number => {
    for (;;) {
      if (s.done) return done(s.value);
      let code: number;
      try {
        code = s.value();
      } catch (error) {
        s = routine.throw(error);
        continue;
      }
      if (code === TJS_E_SUSPENDED)
        return deferSuspended((inner) =>
          step('error' in inner ? routine.throw(inner.error) : routine.next(inner.code)),
        );
      s = routine.next(code);
    }
  };
  return step(routine.next());
}

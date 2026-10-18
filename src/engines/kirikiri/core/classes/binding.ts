/**
 * Shorthands for native class members bound to a native instance type: the
 * `TJS_GET_NATIVE_INSTANCE` check and the argument conversions of the native code.
 */
import {
  TJS_E_BADPARAMCOUNT,
  TJS_E_NATIVECLASSCRASH,
  TJS_S_OK,
  type Dispatch,
  type NativeInstance,
} from '../../tjs2/runtime/interface.js';
import {paramExists, type NativeClass} from '../../tjs2/runtime/native.js';
import type {VariantSlot} from '../../tjs2/runtime/slot.js';
import {asBoolean, asInteger, asReal, asString, type Variant} from '../../tjs2/runtime/variant.js';

/** `(tjs_int)*param`: the integer value truncated to 32 bits. */
export function i32(v: Variant): number {
  return Number(BigInt.asIntN(32, asInteger(v)));
}

/** `(tjs_uint32)(tjs_int64)*param`. */
export function u32(v: Variant): number {
  return Number(BigInt.asUintN(32, asInteger(v)));
}

export function f64(v: Variant): number {
  return asReal(v);
}

export function flag(v: Variant): boolean {
  return asBoolean(v);
}

export function text(v: Variant): string {
  return asString(v);
}

/** The optional argument `n` (given and not void), converted, or `fallback`. */
export function opt<T>(
  args: readonly Variant[],
  n: number,
  convert: (v: Variant) => T,
  fallback: T,
): T {
  return paramExists(args, n) ? convert(args[n]!) : fallback;
}

export type MethodBody<NI> = (
  ni: NI,
  args: readonly Variant[],
  result: VariantSlot | null,
  objthis: Dispatch,
) => number | void;

/** Binds members of `cls` to its native instance type `NI`. */
export class Binder<NI extends NativeInstance> {
  constructor(readonly cls: NativeClass) {}

  ni(objthis: Dispatch | null): NI | null {
    return this.cls.instanceOf<NI>(objthis);
  }

  /** A method needing `minArgs` arguments. */
  method(name: string, minArgs: number, body: MethodBody<NI>, flags = 0): this {
    this.cls.method(
      name,
      (result, args, objthis) => {
        const ni = this.ni(objthis);
        if (!ni) return TJS_E_NATIVECLASSCRASH;
        if (args.length < minArgs) return TJS_E_BADPARAMCOUNT;
        return body(ni, args, result, objthis) ?? TJS_S_OK;
      },
      flags,
    );
    return this;
  }

  /** A property; a missing accessor denies access. */
  prop(
    name: string,
    get?: (ni: NI, objthis: Dispatch) => Variant,
    set?: (ni: NI, v: Variant, objthis: Dispatch) => void,
  ): this {
    this.cls.property(name, {
      get: get
        ? (result, objthis) => {
            const ni = this.ni(objthis);
            if (!ni) return TJS_E_NATIVECLASSCRASH;
            result.set(get(ni, objthis));
            return TJS_S_OK;
          }
        : undefined,
      set: set
        ? (value, objthis) => {
            const ni = this.ni(objthis);
            if (!ni) return TJS_E_NATIVECLASSCRASH;
            set(ni, value, objthis);
            return TJS_S_OK;
          }
        : undefined,
    });
    return this;
  }
}

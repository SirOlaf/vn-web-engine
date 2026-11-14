/**
 * PackinOne's `scriptsEx` (wamsoft scriptsEx as of 2013-04-12): static functions attached to
 * `Scripts` — member lists and counts, closure contexts, structural comparison, `foreach`,
 * octet MD5, deep `clone` — and `Scripts.rehash` (`TJSDoRehash`).
 *
 * Kept as the native plugin behaves: hidden members are skipped by `== TJS_HIDDENMEMBER`, not
 * by bit test, in comparison and iteration; a dictionary member missing from the second
 * operand is not a difference; `clone` of another object calls its `clone` method but uses the
 * result only if the call returns `TJS_S_TRUE`, which methods do not, so the object itself is
 * returned.
 */
import {md5Hex} from '../../core/md5.js';
import type {RawFunction} from './system-ex.js';
import {NcbClassInfo, type NcbAttachDefinition} from '../../engines/kirikiri/tp-stub/ncbind.js';
import {throwFromError} from '../../engines/kirikiri/tp-stub/tp-stub.js';
import {NativeFunction} from '../../engines/kirikiri/tjs2/runtime/native.js';
import {VariantSlot} from '../../engines/kirikiri/tjs2/runtime/slot.js';
import {
  asInteger,
  asObjectClosure,
  asOctet,
  asString,
  bool,
  discernCompare,
  int,
  normalCompare,
  obj,
  str,
  VOID,
} from '../../engines/kirikiri/tjs2/runtime/variant.js';
import {
  TJS_E_BADPARAMCOUNT,
  TJS_E_SUSPENDED,
  TJS_HIDDENMEMBER,
  TJS_IGNOREPROP,
  TJS_MEMBERENSURE,
  TJS_S_OK,
  TJS_S_TRUE,
  TJS_STATICMEMBER,
  type Dispatch,
  type ObjectVariant,
  type Out,
  type TvpFunctionExporter,
  type Variant,
} from '../tvp-plugin/contract.js';

/** `tTJSVariantClosure` calls: the context is `ObjThis`, else the object itself. */
function ctx(c: ObjectVariant): Dispatch | null {
  return c.objthis ?? c.object;
}

function isInstance(c: ObjectVariant, name: string): boolean {
  return c.object?.isInstanceOf(0, null, name, ctx(c)) === TJS_S_TRUE;
}

/** Enumerates a closure's members: `fn(name, flags, value)` returns whether to go on. */
function enumMembers(
  c: ObjectVariant,
  fn: (name: Variant, flags: number, value: Variant) => boolean,
): void {
  const caller = new NativeFunction((result, args) => {
    let go = true;
    if (args.length > 1)
      go = fn(args[0]!, Number(BigInt.asIntN(32, asInteger(args[1]!))), args[2] ?? VOID);
    result?.set(bool(go));
    return TJS_S_OK;
  });
  try {
    c.object?.enumMembers(TJS_IGNOREPROP, obj(caller), ctx(c));
  } finally {
    caller.release();
  }
}

function propGet(
  c: ObjectVariant,
  flag: number,
  name: string | number,
): {hr: number; value: Variant; free(): void} {
  const slot = new VariantSlot();
  const o = c.object;
  const hr = !o
    ? -1
    : typeof name === 'number'
      ? o.propGetByNum(flag, name, slot, ctx(c))
      : o.propGet(flag, name, slot, ctx(c));
  return {hr, value: slot.value, free: () => slot.clear()};
}

function count(c: ObjectVariant): Variant {
  const r = propGet(c, 0, 'count');
  const v = r.value;
  r.free();
  return v;
}

function equalStruct(v1: Variant, v2: Variant, loose: boolean): boolean {
  if (v1.type === 1 && v2.type === 1) {
    if (v1.object === v2.object) return true;
    if (isInstance(v1, 'Function') && isInstance(v2, 'Function')) return discernCompare(v1, v2);
    if (isInstance(v1, 'Array') && isInstance(v2, 'Array')) {
      const c1 = count(v1);
      const c2 = count(v2);
      if (!discernCompare(c1, c2)) return false;
      const n = c1.type === 0 ? 0 : Number(BigInt.asIntN(32, asInteger(c1)));
      for (let i = 0; i < n; i++) {
        const a = propGet(v1, TJS_IGNOREPROP, i);
        const b = propGet(v2, TJS_IGNOREPROP, i);
        const eq = equalStruct(a.value, b.value, loose);
        a.free();
        b.free();
        if (!eq) return false;
      }
      return true;
    }
    if (isInstance(v1, 'Dictionary') && isInstance(v2, 'Dictionary')) {
      const n1: Out<number> = {value: 0};
      const n2: Out<number> = {value: 0};
      v1.object!.getCount(n1, null, ctx(v1));
      v2.object!.getCount(n2, null, ctx(v2));
      if (n1.value !== n2.value) return false;
      let match = true;
      enumMembers(v1, (name, flags, value) => {
        if (flags !== TJS_HIDDENMEMBER) {
          const t = propGet(v2, 0, asString(name));
          if (t.hr === TJS_S_OK) match = match && equalStruct(value, t.value, loose);
          t.free();
          return match;
        }
        return true;
      });
      return match;
    }
  }
  if (loose && (v1.type === 4 || v1.type === 5) && (v2.type === 4 || v2.type === 5))
    return normalCompare(v1, v2);
  return discernCompare(v1, v2);
}

/** `clone`: the result owns one reference when it is an object the clone made. */
function clone(ex: TvpFunctionExporter, v: Variant, out: VariantSlot): void {
  if (v.type === 1) {
    if (isInstance(v, 'Array')) {
      const array = ex.TJSCreateArrayObject();
      const c = count(v);
      const n = c.type === 0 ? 0 : Number(BigInt.asIntN(32, asInteger(c)));
      for (let i = 0; i < n; i++) {
        const item = propGet(v, TJS_IGNOREPROP, i);
        const copy = new VariantSlot();
        clone(ex, item.value, copy);
        item.free();
        array.funcCall(0, 'add', null, [copy.value], array);
        copy.clear();
      }
      out.set(obj(array, array));
      array.release();
      return;
    }
    if (isInstance(v, 'Dictionary')) {
      const dict = ex.TJSCreateDictionaryObject();
      enumMembers(v, (name, flags, value) => {
        const copy = new VariantSlot();
        clone(ex, value, copy);
        dict.propSet(TJS_MEMBERENSURE | flags, asString(name), copy.value, dict);
        copy.clear();
        return true;
      });
      out.set(obj(dict, dict));
      dict.release();
      return;
    }
    const result = new VariantSlot();
    const hr = v.object ? v.object.funcCall(0, 'clone', result, [], ctx(v)) : -1;
    if (hr === TJS_S_TRUE) {
      out.set(result.value);
      result.clear();
      return;
    }
    result.clear();
  }
  out.set(v);
}

export const SCRIPTS_ADD = new NcbClassInfo<object>('ScriptsAdd');

/** `NCB_ATTACH_CLASS(ScriptsAdd, Scripts)`. */
export function scriptsAdd(ex: TvpFunctionExporter): NcbAttachDefinition<object> {
  return {
    info: SCRIPTS_ADD,
    tjs2Class: 'Scripts',
    define: (r) =>
      r
        .rawCallback(
          'getObjectKeys',
          (result, args) => {
            if (args.length < 1) return TJS_E_BADPARAMCOUNT;
            if (result) {
              const array = ex.TJSCreateArrayObject();
              enumMembers(asObjectClosure(args[0]!), (name, flags) => {
                if (!(flags & TJS_HIDDENMEMBER)) array.funcCall(0, 'add', null, [name], array);
                return true;
              });
              result.set(obj(array, array));
              array.release();
            }
            return TJS_S_OK;
          },
          TJS_STATICMEMBER,
        )
        .rawCallback(
          'getObjectCount',
          (result, args) => {
            if (args.length < 1) return TJS_E_BADPARAMCOUNT;
            if (result) {
              const c = asObjectClosure(args[0]!);
              const n: Out<number> = {value: 0};
              c.object?.getCount(n, null, ctx(c));
              result.set(int(n.value));
            }
            return TJS_S_OK;
          },
          TJS_STATICMEMBER,
        )
        .staticMethod('getObjectContext', 1, (args) => {
          const t = asObjectClosure(args[0]!).objthis;
          return obj(t, t);
        })
        .staticMethod('isNullContext', 1, (args) =>
          bool(asObjectClosure(args[0]!).objthis === null),
        )
        .staticMethod('equalStruct', 2, (args) => bool(equalStruct(args[0]!, args[1]!, false)))
        .staticMethod('equalStructNumericLoose', 2, (args) =>
          bool(equalStruct(args[0]!, args[1]!, true)),
        )
        .rawCallback(
          'foreach',
          (result, args, objthis) => {
            if (args.length < 2) return TJS_E_BADPARAMCOUNT;
            const target = asObjectClosure(args[0]!);
            const f = asObjectClosure(args[1]!);
            const func = f.object;
            const functhis = f.objthis ?? objthis;
            const rest = args.slice(2);
            const breakResult = new VariantSlot();
            const call = (key: Variant, value: Variant) => {
              breakResult.clear();
              const hr = func
                ? func.funcCall(0, null, breakResult, [key, value, ...rest], functhis)
                : -1;
              if (hr === TJS_E_SUSPENDED) throwFromError(ex, hr);
            };
            if (isInstance(target, 'Array')) {
              const c = count(target);
              const n = c.type === 0 ? 0 : Number(BigInt.asIntN(32, asInteger(c)));
              for (let i = 0; i < n; i++) {
                const item = propGet(target, TJS_IGNOREPROP, i);
                call(int(i), item.value);
                item.free();
                if (breakResult.value.type !== 0) break;
              }
            } else {
              enumMembers(target, (name, flags, value) => {
                breakResult.clear();
                if (flags !== TJS_HIDDENMEMBER) call(name, value);
                return breakResult.value.type === 0;
              });
            }
            result?.set(breakResult.value);
            breakResult.clear();
            return TJS_S_OK;
          },
          TJS_STATICMEMBER,
        )
        .rawCallback(
          'getMD5HashString',
          (result, args) => {
            if (args.length < 1) return TJS_E_BADPARAMCOUNT;
            result?.set(str(md5Hex(asOctet(args[0]!))));
            return TJS_S_OK;
          },
          TJS_STATICMEMBER,
        )
        .staticMethod('clone', 1, (args, _o, result) => {
          const out = new VariantSlot();
          clone(ex, args[0]!, out);
          result?.set(out.value);
          out.clear();
        }),
  };
}

/** `NCB_ATTACH_FUNCTION(rehash, Scripts, TJSDoRehash)`. */
export function scriptsRehash(ex: TvpFunctionExporter): RawFunction {
  return () => {
    ex.TJSDoRehash();
    return TJS_S_OK;
  };
}

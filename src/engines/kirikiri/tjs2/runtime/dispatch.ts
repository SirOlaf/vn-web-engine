/**
 * `tTJSDispatch` (the base of every native-side TJS object) and the default member handlers
 * (`TJSDefaultFuncCall`, `TJSDefaultPropGet`, …) that give a member holding an object its
 * function, property and class behaviour (krkrz `tjsObject.cpp`).
 */
import {throwTjsError} from './errors.js';
import {deferSuspended} from './suspension.js';
import {
  failed,
  succeeded,
  TJS_E_INVALIDOBJECT,
  TJS_E_INVALIDPARAM,
  TJS_E_INVALIDTYPE,
  TJS_E_MEMBERNOTFOUND,
  TJS_E_NOTIMPL,
  TJS_E_SUSPENDED,
  TJS_IGNOREPROP,
  TJS_OP_DEC,
  TJS_OP_INC,
  TJS_OP_MASK,
  TJS_OP_MAX,
  TJS_OP_MIN,
  TJS_S_FALSE,
  TJS_S_OK,
  TJS_S_TRUE,
  type Dispatch,
  type NativeInstance,
  type Out,
} from './interface.js';
import {VariantSlot, type VariantCell} from './slot.js';
import {asObjectClosure, variantOperation, type ObjectVariant, type Variant} from './variant.js';

/** `TJS_int_to_str` of a member index. */
function numName(num: number): string {
  return String(num | 0);
}

/**
 * `tTJSDispatch`: reference counting and the defaults of every method. Methods that address
 * a member by number call the by-name method with the decimal name.
 */
export abstract class DispatchBase implements Dispatch {
  #refCount = 1;
  #beforeDestructionCalled = false;

  addRef(): number {
    return ++this.#refCount;
  }

  release(): number {
    if (this.#refCount === 1) {
      if (!this.#beforeDestructionCalled) {
        this.#beforeDestructionCalled = true;
        this.beforeDestruction();
      }
      if (this.#refCount === 1) {
        this.#refCount = 0;
        this.destruct();
        return 0;
      }
    }
    return --this.#refCount;
  }

  protected get refCount(): number {
    return this.#refCount;
  }

  /** Called once before the object is destroyed, while it is still usable. */
  protected beforeDestruction(): void {}

  /** The C++ destructor. */
  protected destruct(): void {}

  funcCall(
    _flag: number,
    member: string | null,
    _result: VariantSlot | null,
    _args: readonly Variant[],
    _objthis: Dispatch | null,
  ): number {
    return member !== null ? TJS_E_MEMBERNOTFOUND : TJS_E_NOTIMPL;
  }
  funcCallByNum(
    flag: number,
    num: number,
    result: VariantSlot | null,
    args: readonly Variant[],
    objthis: Dispatch | null,
  ): number {
    return this.funcCall(flag, numName(num), result, args, objthis);
  }
  propGet(
    _flag: number,
    member: string | null,
    _result: VariantSlot | null,
    _objthis: Dispatch | null,
  ): number {
    return member !== null ? TJS_E_MEMBERNOTFOUND : TJS_E_NOTIMPL;
  }
  propGetByNum(
    flag: number,
    num: number,
    result: VariantSlot | null,
    objthis: Dispatch | null,
  ): number {
    return this.propGet(flag, numName(num), result, objthis);
  }
  propSet(
    _flag: number,
    member: string | null,
    _value: Variant,
    _objthis: Dispatch | null,
  ): number {
    return member !== null ? TJS_E_MEMBERNOTFOUND : TJS_E_NOTIMPL;
  }
  propSetByNum(flag: number, num: number, value: Variant, objthis: Dispatch | null): number {
    return this.propSet(flag, numName(num), value, objthis);
  }
  getCount(_result: Out<number>, _member: string | null, _objthis: Dispatch | null): number {
    return TJS_E_NOTIMPL;
  }
  getCountByNum(result: Out<number>, num: number, objthis: Dispatch | null): number {
    return this.getCount(result, numName(num), objthis);
  }
  enumMembers(_flag: number, _callback: ObjectVariant, _objthis: Dispatch | null): number {
    return TJS_E_NOTIMPL;
  }
  deleteMember(_flag: number, member: string | null, _objthis: Dispatch | null): number {
    return member !== null ? TJS_E_MEMBERNOTFOUND : TJS_E_NOTIMPL;
  }
  deleteMemberByNum(flag: number, num: number, objthis: Dispatch | null): number {
    return this.deleteMember(flag, numName(num), objthis);
  }
  invalidate(_flag: number, member: string | null, _objthis: Dispatch | null): number {
    return member !== null ? TJS_E_MEMBERNOTFOUND : TJS_E_NOTIMPL;
  }
  invalidateByNum(flag: number, num: number, objthis: Dispatch | null): number {
    return this.invalidate(flag, numName(num), objthis);
  }
  isValid(_flag: number, member: string | null, _objthis: Dispatch | null): number {
    return member !== null ? TJS_E_MEMBERNOTFOUND : TJS_E_NOTIMPL;
  }
  isValidByNum(flag: number, num: number, objthis: Dispatch | null): number {
    return this.isValid(flag, numName(num), objthis);
  }
  createNew(
    _flag: number,
    member: string | null,
    _result: Out<Dispatch | null>,
    _args: readonly Variant[],
    _objthis: Dispatch | null,
  ): number {
    return member !== null ? TJS_E_MEMBERNOTFOUND : TJS_E_NOTIMPL;
  }
  createNewByNum(
    flag: number,
    num: number,
    result: Out<Dispatch | null>,
    args: readonly Variant[],
    objthis: Dispatch | null,
  ): number {
    return this.createNew(flag, numName(num), result, args, objthis);
  }
  isInstanceOf(
    _flag: number,
    member: string | null,
    _className: string,
    _objthis: Dispatch | null,
  ): number {
    return member !== null ? TJS_E_MEMBERNOTFOUND : TJS_E_NOTIMPL;
  }
  isInstanceOfByNum(
    flag: number,
    num: number,
    className: string,
    objthis: Dispatch | null,
  ): number {
    return this.isInstanceOf(flag, numName(num), className, objthis);
  }
  /** Reads the member, applies the operation, writes it back. */
  operation(
    flag: number,
    member: string | null,
    result: VariantSlot | null,
    param: Variant | null,
    objthis: Dispatch | null,
  ): number {
    const op = flag & TJS_OP_MASK;
    if (op !== TJS_OP_INC && op !== TJS_OP_DEC && param === null) return TJS_E_INVALIDPARAM;
    if (op < TJS_OP_MIN || op > TJS_OP_MAX) return TJS_E_INVALIDPARAM;
    return readModifyWrite(
      (into) => this.propGet(0, member, into, objthis),
      (value) => this.propSet(0, member, value, objthis),
      op,
      param,
      result,
    );
  }
  operationByNum(
    flag: number,
    num: number,
    result: VariantSlot | null,
    param: Variant | null,
    objthis: Dispatch | null,
  ): number {
    return this.operation(flag, numName(num), result, param, objthis);
  }
  nativeInstanceSupport(
    _flag: number,
    _classId: number,
    _pointer: Out<NativeInstance | null>,
  ): number {
    return TJS_E_NOTIMPL;
  }
  classInstanceInfo(_flag: number, _num: number, _value: VariantSlot): number {
    return TJS_E_NOTIMPL;
  }
}

/** `TJS_SELECT_OBJTHIS`: the closure's own context wins over the caller's. */
export function selectObjthis(closure: ObjectVariant, override: Dispatch | null): Dispatch | null {
  return closure.objthis ?? override;
}

function nullAccess(): never {
  throwTjsError('TJSNullAccess');
}

/**
 * Calls a closure as `tTJSVariantClosure::FuncCall` does: the context is the closure's
 * objthis, else `objthis`, else the object itself. Throws on a null object.
 */
export function closureFuncCall(
  closure: ObjectVariant,
  flag: number,
  member: string | null,
  result: VariantSlot | null,
  args: readonly Variant[],
  objthis: Dispatch | null,
): number {
  const o = closure.object ?? nullAccess();
  return o.funcCall(flag, member, result, args, closure.objthis ?? objthis ?? o);
}

export function closurePropGet(
  closure: ObjectVariant,
  flag: number,
  member: string | null,
  result: VariantSlot | null,
  objthis: Dispatch | null,
): number {
  const o = closure.object ?? nullAccess();
  return o.propGet(flag, member, result, closure.objthis ?? objthis ?? o);
}

export function closurePropSet(
  closure: ObjectVariant,
  flag: number,
  member: string | null,
  value: Variant,
  objthis: Dispatch | null,
): number {
  const o = closure.object ?? nullAccess();
  return o.propSet(flag, member, value, closure.objthis ?? objthis ?? o);
}

export function closureCreateNew(
  closure: ObjectVariant,
  flag: number,
  member: string | null,
  result: Out<Dispatch | null>,
  args: readonly Variant[],
  objthis: Dispatch | null,
): number {
  const o = closure.object ?? nullAccess();
  return o.createNew(flag, member, result, args, closure.objthis ?? objthis ?? o);
}

/** Codes after which a default handler falls back to treating the member as a plain value. */
function fallsBack(hr: number): boolean {
  return hr === TJS_E_NOTIMPL || hr === TJS_E_INVALIDTYPE || hr === TJS_E_INVALIDOBJECT;
}

/**
 * Continues with `next(code)` once the call that returned `hr` has completed: at once, or
 * behind it when it suspended. `cleanup` runs when the suspended call throws instead.
 */
function afterCall(hr: number, next: (code: number) => number, cleanup: () => void): number {
  if (hr !== TJS_E_SUSPENDED) return next(hr);
  return deferSuspended((o) => {
    if ('error' in o) {
      cleanup();
      throw o.error;
    }
    return next(o.code);
  });
}

/** `TJSTryFuncCallViaPropGet`: calls what the object's default property yields. */
function funcCallViaPropGet(
  closure: ObjectVariant,
  flag: number,
  result: VariantSlot | null,
  args: readonly Variant[],
  objthis: Dispatch | null,
): number {
  const tmp = new VariantSlot();
  const clear = () => tmp.clear();
  try {
    const er = closure.object!.propGet(0, null, tmp, selectObjthis(closure, objthis));
    // A getter may suspend (a lazily loaded class or function); the call follows it.
    return afterCall(
      er,
      (code) => {
        try {
          if (!succeeded(code)) return code;
          const inner = asObjectClosure(tmp.value);
          return inner.object!.funcCall(flag, null, result, args, selectObjthis(inner, objthis));
        } finally {
          clear();
        }
      },
      clear,
    );
  } catch (e) {
    clear();
    throw e;
  }
}

/**
 * Reads a value with `get`, applies `op` and writes it with `set`; the new value goes to
 * `result`. Either handler may suspend. `notFound` decides what a failed read returns.
 */
export function readModifyWrite(
  get: (into: VariantSlot) => number,
  set: (value: Variant) => number,
  op: number,
  param: Variant | null,
  result: VariantSlot | null,
  notFound: (code: number) => number = (code) => code,
): number {
  const tmp = new VariantSlot();
  const clear = () => tmp.clear();
  const written = (hr: number): number => {
    if (succeeded(hr)) result?.set(tmp.value);
    clear();
    return failed(hr) ? hr : TJS_S_OK;
  };
  const read = (hr: number): number => {
    if (!succeeded(hr)) {
      clear();
      return notFound(hr);
    }
    tmp.set(variantOperation(op, tmp.value, param));
    return afterCall(set(tmp.value), written, clear);
  };
  try {
    return afterCall(get(tmp), read, clear);
  } catch (e) {
    clear();
    throw e;
  }
}

/** `TJSDefaultFuncCall`: calls a member that holds a function object. */
export function defaultFuncCall(
  flag: number,
  target: Variant,
  result: VariantSlot | null,
  args: readonly Variant[],
  objthis: Dispatch | null,
): number {
  if (target.type !== 1) return TJS_E_INVALIDTYPE;
  if (!target.object) return TJS_E_INVALIDTYPE;
  let er = target.object.funcCall(flag, null, result, args, selectObjthis(target, objthis));
  if (er === TJS_E_INVALIDTYPE) er = funcCallViaPropGet(target, flag, result, args, objthis);
  return er;
}

/**
 * `TJSDefaultPropGet`: unless `TJS_IGNOREPROP`, a member holding an object is asked for its
 * default property (a property object answers with its getter); otherwise the value itself.
 */
export function defaultPropGet(
  flag: number,
  target: Variant,
  result: VariantSlot | null,
  objthis: Dispatch | null,
): number {
  if (!(flag & TJS_IGNOREPROP) && target.type === 1 && target.object) {
    const hr = target.object.propGet(0, null, result, selectObjthis(target, objthis));
    if (succeeded(hr)) return hr;
    if (!fallsBack(hr)) return hr;
  }
  if (!result) return TJS_E_INVALIDPARAM;
  result.set(target);
  return TJS_S_OK;
}

/** `TJSDefaultPropSet`: the property setter of an object member, or plain assignment. */
export function defaultPropSet(
  flag: number,
  target: VariantCell,
  value: Variant,
  objthis: Dispatch | null,
): number {
  const t = target.value;
  if (!(flag & TJS_IGNOREPROP) && t.type === 1 && t.object) {
    const hr = t.object.propSet(0, null, value, selectObjthis(t, objthis));
    if (succeeded(hr)) return hr;
    if (!fallsBack(hr)) return hr;
  }
  target.set(value);
  return TJS_S_OK;
}

/** `TJSDefaultInvalidate`. */
export function defaultInvalidate(flag: number, target: Variant, objthis: Dispatch | null): number {
  if (target.type === 1 && target.object)
    return target.object.invalidate(flag, null, selectObjthis(target, objthis));
  return TJS_S_FALSE;
}

/** `TJSDefaultIsValid`: non-objects are valid. */
export function defaultIsValid(flag: number, target: Variant, objthis: Dispatch | null): number {
  if (target.type === 1 && target.object)
    return target.object.isValid(flag, null, selectObjthis(target, objthis));
  return TJS_S_TRUE;
}

/** `TJSDefaultCreateNew`. */
export function defaultCreateNew(
  flag: number,
  target: Variant,
  result: Out<Dispatch | null>,
  args: readonly Variant[],
  objthis: Dispatch | null,
): number {
  if (target.type === 1 && target.object)
    return target.object.createNew(flag, null, result, args, selectObjthis(target, objthis));
  return TJS_E_INVALIDTYPE;
}

/** `TJSDefaultIsInstanceOf`: "Object" for every non-void value, "Number", "String", "Octet". */
export function defaultIsInstanceOf(
  flag: number,
  target: Variant,
  name: string,
  objthis: Dispatch | null,
): number {
  if (target.type === 0) return TJS_S_FALSE;
  if (name === 'Object') return TJS_S_TRUE;
  switch (target.type) {
    case 4:
    case 5:
      return name === 'Number' ? TJS_S_TRUE : TJS_S_FALSE;
    case 2:
      return name === 'String' ? TJS_S_TRUE : TJS_S_FALSE;
    case 3:
      return name === 'Octet' ? TJS_S_TRUE : TJS_S_FALSE;
    case 1:
      if (target.object)
        return target.object.isInstanceOf(flag, null, name, selectObjthis(target, objthis));
      return TJS_S_FALSE;
  }
}

/**
 * `TJSDefaultOperation`: a property member is read, changed and written through its handler;
 * any other member is changed in place.
 */
export function defaultOperation(
  flag: number,
  target: VariantCell,
  result: VariantSlot | null,
  param: Variant | null,
  objthis: Dispatch | null,
): number {
  const op = flag & TJS_OP_MASK;
  if (op !== TJS_OP_INC && op !== TJS_OP_DEC && param === null) return TJS_E_INVALIDPARAM;
  if (op < TJS_OP_MIN || op > TJS_OP_MAX) return TJS_E_INVALIDPARAM;
  const t = target.value;
  if (t.type === 1 && t.object) {
    const r = propertyOperation(op, t, result, param, objthis);
    if (r !== null) return r;
  }
  target.set(variantOperation(op, target.value, param));
  result?.set(target.value);
  return TJS_S_OK;
}

/**
 * The property branch of `TJSDefaultOperation`. Returns null when the object has no default
 * property, so that the member is changed as a value.
 */
export function propertyOperation(
  op: number,
  closure: ObjectVariant,
  result: VariantSlot | null,
  param: Variant | null,
  objthis: Dispatch | null,
): number | null {
  const ot = selectObjthis(closure, objthis);
  const o = closure.object!;
  let noProperty = false;
  const hr = readModifyWrite(
    (into) => o.propGet(0, null, into, ot),
    (value) => o.propSet(0, null, value, ot),
    op,
    param,
    result,
    (code) => {
      noProperty = fallsBack(code);
      return code;
    },
  );
  return noProperty ? null : hr;
}

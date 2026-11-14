import {
  TJS_E_MEMBERNOTFOUND,
  TJS_E_NOTIMPL,
  type Dispatch,
  type NativeInstance,
  type ObjectVariant,
  type Out,
  type Variant,
  type VariantResult,
} from '../runtime/interface.js';

/**
 * `tTJSObjectProxy`: register -2 of a running function, through which names that are not
 * locals are looked up. Every access goes to `this` first and, when the member is not found
 * there, to `global`; the context passed down is the caller's, else the object accessed. The
 * proxy is not reference counted; the running function keeps both objects alive.
 */
export class ObjectProxy implements Dispatch {
  constructor(
    readonly dispatch1: Dispatch,
    readonly dispatch2: Dispatch,
  ) {}

  addRef(): number {
    return 1;
  }
  release(): number {
    return 1;
  }

  #both(call: (d: Dispatch, objthis: Dispatch) => number, objthis: Dispatch | null): number {
    const hr = call(this.dispatch1, objthis ?? this.dispatch1);
    if (hr === TJS_E_MEMBERNOTFOUND && this.dispatch1 !== this.dispatch2)
      return call(this.dispatch2, objthis ?? this.dispatch2);
    return hr;
  }

  funcCall(
    flag: number,
    member: string | null,
    result: VariantResult | null,
    args: readonly Variant[],
    objthis: Dispatch | null,
  ): number {
    return this.#both((d, o) => d.funcCall(flag, member, result, args, o), objthis);
  }
  funcCallByNum(
    flag: number,
    num: number,
    result: VariantResult | null,
    args: readonly Variant[],
    objthis: Dispatch | null,
  ): number {
    return this.#both((d, o) => d.funcCallByNum(flag, num, result, args, o), objthis);
  }
  propGet(
    flag: number,
    member: string | null,
    result: VariantResult | null,
    objthis: Dispatch | null,
  ): number {
    return this.#both((d, o) => d.propGet(flag, member, result, o), objthis);
  }
  propGetByNum(
    flag: number,
    num: number,
    result: VariantResult | null,
    objthis: Dispatch | null,
  ): number {
    return this.#both((d, o) => d.propGetByNum(flag, num, result, o), objthis);
  }
  propSet(flag: number, member: string | null, value: Variant, objthis: Dispatch | null): number {
    return this.#both((d, o) => d.propSet(flag, member, value, o), objthis);
  }
  propSetByNum(flag: number, num: number, value: Variant, objthis: Dispatch | null): number {
    return this.#both((d, o) => d.propSetByNum(flag, num, value, o), objthis);
  }
  getCount(result: Out<number>, member: string | null, objthis: Dispatch | null): number {
    return this.#both((d, o) => d.getCount(result, member, o), objthis);
  }
  getCountByNum(result: Out<number>, num: number, objthis: Dispatch | null): number {
    return this.#both((d, o) => d.getCountByNum(result, num, o), objthis);
  }
  enumMembers(_flag: number, _callback: ObjectVariant, _objthis: Dispatch | null): number {
    return TJS_E_NOTIMPL;
  }
  deleteMember(flag: number, member: string | null, objthis: Dispatch | null): number {
    return this.#both((d, o) => d.deleteMember(flag, member, o), objthis);
  }
  deleteMemberByNum(flag: number, num: number, objthis: Dispatch | null): number {
    return this.#both((d, o) => d.deleteMemberByNum(flag, num, o), objthis);
  }
  invalidate(flag: number, member: string | null, objthis: Dispatch | null): number {
    return this.#both((d, o) => d.invalidate(flag, member, o), objthis);
  }
  invalidateByNum(flag: number, num: number, objthis: Dispatch | null): number {
    return this.#both((d, o) => d.invalidateByNum(flag, num, o), objthis);
  }
  isValid(flag: number, member: string | null, objthis: Dispatch | null): number {
    return this.#both((d, o) => d.isValid(flag, member, o), objthis);
  }
  isValidByNum(flag: number, num: number, objthis: Dispatch | null): number {
    return this.#both((d, o) => d.isValidByNum(flag, num, o), objthis);
  }
  createNew(
    flag: number,
    member: string | null,
    result: Out<Dispatch | null>,
    args: readonly Variant[],
    objthis: Dispatch | null,
  ): number {
    return this.#both((d, o) => d.createNew(flag, member, result, args, o), objthis);
  }
  createNewByNum(
    flag: number,
    num: number,
    result: Out<Dispatch | null>,
    args: readonly Variant[],
    objthis: Dispatch | null,
  ): number {
    return this.#both((d, o) => d.createNewByNum(flag, num, result, args, o), objthis);
  }
  isInstanceOf(
    flag: number,
    member: string | null,
    className: string,
    objthis: Dispatch | null,
  ): number {
    return this.#both((d, o) => d.isInstanceOf(flag, member, className, o), objthis);
  }
  isInstanceOfByNum(
    flag: number,
    num: number,
    className: string,
    objthis: Dispatch | null,
  ): number {
    return this.#both((d, o) => d.isInstanceOfByNum(flag, num, className, o), objthis);
  }
  operation(
    flag: number,
    member: string | null,
    result: VariantResult | null,
    param: Variant | null,
    objthis: Dispatch | null,
  ): number {
    return this.#both((d, o) => d.operation(flag, member, result, param, o), objthis);
  }
  operationByNum(
    flag: number,
    num: number,
    result: VariantResult | null,
    param: Variant | null,
    objthis: Dispatch | null,
  ): number {
    return this.#both((d, o) => d.operationByNum(flag, num, result, param, o), objthis);
  }
  nativeInstanceSupport(
    _flag: number,
    _classId: number,
    _pointer: Out<NativeInstance | null>,
  ): number {
    return TJS_E_NOTIMPL;
  }
  classInstanceInfo(_flag: number, _num: number, _value: VariantResult): number {
    return TJS_E_NOTIMPL;
  }
}

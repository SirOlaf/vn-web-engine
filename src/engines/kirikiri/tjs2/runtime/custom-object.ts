/**
 * `tTJSCustomObject` (krkrz `tjsObject.cpp`): the object behind script instances,
 * dictionaries, arrays and native classes. Members live in a chained hash table whose layout
 * is ported exactly, because enumeration (`Scripts.foreach`, `saveStruct`, `keys`) walks it:
 * buckets in index order, each bucket's chain before its first-level entry, chains in
 * insertion-after-head order, and lookups moving a deep chain entry to the front.
 */
import {throwTjsError} from './errors.js';
import {
  DispatchBase,
  closureFuncCall,
  defaultCreateNew,
  defaultFuncCall,
  defaultInvalidate,
  defaultIsInstanceOf,
  defaultIsValid,
  defaultPropGet,
  propertyOperation,
  selectObjthis,
} from './dispatch.js';
import {
  failed,
  succeeded,
  TJS_CII_ADD,
  TJS_CII_GET,
  TJS_CII_SET_FINALIZE,
  TJS_CII_SET_MISSING,
  TJS_E_FAIL,
  TJS_E_INVALIDOBJECT,
  TJS_E_INVALIDPARAM,
  TJS_E_INVALIDTYPE,
  TJS_E_MEMBERNOTFOUND,
  TJS_E_NOTIMPL,
  TJS_ENUM_NO_VALUE,
  TJS_HIDDENMEMBER,
  TJS_IGNOREPROP,
  TJS_MEMBERENSURE,
  TJS_NIS_GETINSTANCE,
  TJS_NIS_REGISTER,
  TJS_OP_DEC,
  TJS_OP_INC,
  TJS_OP_MASK,
  TJS_OP_MAX,
  TJS_OP_MIN,
  TJS_S_FALSE,
  TJS_S_OK,
  TJS_S_TRUE,
  TJS_STATICMEMBER,
  type Dispatch,
  type NativeInstance,
  type Out,
} from './interface.js';
import {VariantSlot} from './slot.js';
import {
  asBoolean,
  asString,
  bool,
  int,
  obj,
  str,
  variantOperation,
  type ObjectVariant,
  type Variant,
} from './variant.js';

export const TJS_NAMESPACE_DEFAULT_HASH_BITS = 3;
export const TJS_MAX_NATIVE_CLASS = 4;

const SYMBOL_USING = 0x1;
const SYMBOL_INIT = 0x2;
const SYMBOL_HIDDEN = 0x8;
const SYMBOL_STATIC = 0x10;

/** `tTJSHashFunc<tjs_char *>`: one-at-a-time hash over UTF-16 code units, up to a NUL. */
export function tjsHash(name: string): number {
  let ret = 0;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c === 0) break;
    ret = (ret + c) >>> 0;
    ret = (ret + (ret << 10)) >>> 0;
    ret = (ret ^ (ret >>> 6)) >>> 0;
  }
  ret = (ret + (ret << 3)) >>> 0;
  ret = (ret ^ (ret >>> 11)) >>> 0;
  ret = (ret + (ret << 15)) >>> 0;
  return ret === 0 ? 0xffffffff : ret;
}

/** `tTJSSymbolData`. */
class SymbolData {
  name: string | null = null;
  hash = 0;
  symFlags = 0;
  readonly slot = new VariantSlot();
  next: SymbolData | null = null;

  selfClear(): void {
    this.name = null;
    this.hash = 0;
    this.slot.take();
    this.next = null;
    this.symFlags = SYMBOL_INIT;
  }
  setName(name: string, hash: number): void {
    if (!name) throwTjsError('TJSIDExpected');
    this.name = name;
    this.hash = hash;
  }
  /** `PostClear`: forgets the name and value of a first-level entry. */
  postClear(): void {
    this.name = null;
    this.slot.clear();
    this.symFlags &= ~SYMBOL_USING;
  }
}

/** Global rehash generation (`TJSDoRehash`, `Scripts.rehash`). */
let globalRebuildHashMagic = 0;
export function tjsDoRehash(): void {
  globalRebuildHashMagic++;
}

let objectHashBitsLimit = 32;
/** `TJSObjectHashBitsLimit`: caps hash table growth. */
export function setObjectHashBitsLimit(bits: number): void {
  objectHashBitsLimit = bits;
}

/**
 * A property object over one variant, handed to `missing` (`tTJSSimpleGetSetProperty`).
 */
class SimpleGetSetProperty extends DispatchBase {
  constructor(readonly value: VariantSlot) {
    super();
  }
  override propGet(
    _flag: number,
    member: string | null,
    result: VariantSlot | null,
    _objthis: Dispatch | null,
  ): number {
    if (member !== null) return TJS_E_MEMBERNOTFOUND;
    result?.set(this.value.value);
    return TJS_S_OK;
  }
  override propSet(
    _flag: number,
    member: string | null,
    value: Variant,
    _objthis: Dispatch | null,
  ): number {
    if (member !== null) return TJS_E_MEMBERNOTFOUND;
    this.value.set(value);
    return TJS_S_OK;
  }
}

export class CustomObject extends DispatchBase {
  #count = 0;
  #hashMask: number;
  #hashSize: number;
  #symbols: SymbolData[];
  #rebuildHashMagic = globalRebuildHashMagic;
  #isInvalidated = false;
  #isInvalidating = false;
  readonly #classInstances: (NativeInstance | null)[] = new Array(TJS_MAX_NATIVE_CLASS).fill(null);
  readonly #classIds: number[] = new Array(TJS_MAX_NATIVE_CLASS).fill(-1);

  protected callFinalize = true;
  protected finalizeName = 'finalize';
  protected callMissing = false;
  #processingMissing = false;
  protected missingName = 'missing';
  protected readonly classNames: string[] = [];

  constructor(hashBits = TJS_NAMESPACE_DEFAULT_HASH_BITS) {
    super();
    if (hashBits > objectHashBitsLimit) hashBits = objectHashBitsLimit;
    this.#hashSize = 1 << hashBits;
    this.#hashMask = this.#hashSize - 1;
    this.#symbols = newTable(this.#hashSize);
  }

  protected get validity(): boolean {
    return !this.#isInvalidated;
  }

  /** Number of members. */
  get count(): number {
    return this.#count;
  }

  protected override destruct(): void {
    for (let i = TJS_MAX_NATIVE_CLASS - 1; i >= 0; i--)
      if (this.#classIds[i] !== -1) this.#classInstances[i]?.destruct();
  }

  #finalizeOnce(): void {
    if (this.#isInvalidating) return;
    this.#isInvalidating = true;
    try {
      if (!this.#isInvalidated) {
        this.finalize();
        this.#isInvalidated = true;
      }
    } finally {
      this.#isInvalidating = false;
    }
  }

  /** Calls the `finalize` method, invalidates native instances, deletes every member. */
  protected finalize(): void {
    if (this.callFinalize) this.funcCall(0, this.finalizeName, null, [], this);
    for (let i = TJS_MAX_NATIVE_CLASS - 1; i >= 0; i--)
      if (this.#classIds[i] !== -1) this.#classInstances[i]?.invalidate();
    this.#deleteAllMembers();
  }

  protected override beforeDestruction(): void {
    this.#finalizeOnce();
  }

  // An object closure stored in a member whose objthis is this object holds no reference on
  // it, so that methods bound to their own object do not keep it alive.
  protected checkClosureAdd(v: Variant): void {
    if (v.type === 1 && v.objthis === this) this.release();
  }
  protected checkClosureRemove(v: Variant): void {
    if (v.type === 1 && v.objthis === this) this.addRef();
  }

  #callGetMissing(name: string, result: VariantSlot): boolean {
    if (this.#processingMissing) return false;
    this.#processingMissing = true;
    const value = new VariantSlot();
    const prop = new SimpleGetSetProperty(value);
    const funcResult = new VariantSlot();
    try {
      const er = this.funcCall(
        0,
        this.missingName,
        funcResult,
        [bool(false), str(name), obj(prop)],
        this,
      );
      if (failed(er)) return false;
      const found = asBoolean(funcResult.value);
      result.set(value.value);
      return found;
    } finally {
      funcResult.clear();
      prop.release();
      value.clear();
      this.#processingMissing = false;
    }
  }

  #callSetMissing(name: string, v: Variant): boolean {
    if (this.#processingMissing) return false;
    this.#processingMissing = true;
    const value = new VariantSlot(v);
    const prop = new SimpleGetSetProperty(value);
    const funcResult = new VariantSlot();
    try {
      const er = this.funcCall(
        0,
        this.missingName,
        funcResult,
        [bool(true), str(name), obj(prop)],
        this,
      );
      if (failed(er)) return false;
      return asBoolean(funcResult.value);
    } finally {
      funcResult.clear();
      prop.release();
      value.clear();
      this.#processingMissing = false;
    }
  }

  #add(name: string): SymbolData {
    const found = this.#find(name);
    if (found) return found;
    const hash = tjsHash(name);
    const lv1 = this.#symbols[hash & this.#hashMask]!;
    let data: SymbolData;
    if (lv1.symFlags & SYMBOL_USING) {
      data = new SymbolData();
      data.selfClear();
      data.next = lv1.next;
      lv1.next = data;
      data.setName(name, hash);
      data.symFlags |= SYMBOL_USING;
    } else {
      if (!(lv1.symFlags & SYMBOL_INIT)) lv1.selfClear();
      lv1.setName(name, hash);
      lv1.symFlags |= SYMBOL_USING;
      data = lv1;
    }
    this.#count++;
    return data;
  }

  #find(name: string): SymbolData | null {
    const hash = tjsHash(name);
    const lv1 = this.#symbols[hash & this.#hashMask]!;
    if (!(lv1.symFlags & SYMBOL_USING) && lv1.next === null) return null;
    let cnt = 0;
    let prevd = lv1;
    for (let d = lv1.next; d; prevd = d, d = d.next, cnt++) {
      if (d.hash === hash && d.symFlags & SYMBOL_USING && d.name === name) {
        if (cnt > 2) {
          // move to the front of the chain
          prevd.next = d.next;
          d.next = lv1.next;
          lv1.next = d;
        }
        return d;
      }
    }
    if (lv1.hash === hash && lv1.symFlags & SYMBOL_USING && lv1.name === name) return lv1;
    return null;
  }

  #deleteByName(name: string): boolean {
    const hash = tjsHash(name);
    const lv1 = this.#symbols[hash & this.#hashMask]!;
    if (!(lv1.symFlags & SYMBOL_USING) && lv1.next === null) return false;
    if (lv1.symFlags & SYMBOL_USING && lv1.name === name) {
      this.checkClosureRemove(lv1.slot.value);
      lv1.postClear();
      this.#count--;
      return true;
    }
    let prevd = lv1;
    for (let d = lv1.next; d; prevd = d, d = d.next) {
      if (d.symFlags & SYMBOL_USING && d.hash === hash && d.name === name) {
        prevd.next = d.next;
        this.checkClosureRemove(d.slot.value);
        d.slot.clear();
        this.#count--;
        return true;
      }
    }
    return false;
  }

  /** Every symbol in enumeration order: per bucket, the chain, then the first-level entry. */
  *#walk(symbols: SymbolData[] = this.#symbols): Generator<SymbolData> {
    for (const lv1 of symbols) {
      for (let d = lv1.next; d;) {
        const next = d.next;
        if (d.symFlags & SYMBOL_USING) yield d;
        d = next;
      }
      if (lv1.symFlags & SYMBOL_USING) yield lv1;
    }
  }

  /**
   * `DeleteAllMembers`: detaches every object value first, then empties the table, then
   * releases the detached objects, so finalizers see an empty object.
   */
  #deleteAllMembers(): void {
    const held: Variant[] = [];
    for (const d of this.#walk()) {
      const v = d.slot.value;
      if (v.type === 1) {
        this.checkClosureRemove(v);
        held.push(d.slot.take());
      }
    }
    for (const lv1 of this.#symbols) {
      for (let d = lv1.next; d; d = d.next) if (d.symFlags & SYMBOL_USING) d.slot.clear();
      if (lv1.symFlags & SYMBOL_USING) lv1.postClear();
      lv1.next = null;
    }
    this.#count = 0;
    for (const v of held) {
      if (v.type === 1) {
        v.object?.release();
        v.objthis?.release();
      }
    }
  }

  /** `Clear`. */
  clear(): void {
    this.#deleteAllMembers();
  }

  /** `RebuildHash(requestcount)`: resizes the table for a member count. */
  rebuildHash(requestCount = this.#count): void {
    this.#rebuildHashMagic = globalRebuildHashMagic;
    let r: number,
      v = requestCount;
    if (v & 0xffff0000) {
      r = 16;
      v >>= 16;
    } else r = 0;
    if (v & 0xff00) {
      r += 8;
      v >>= 8;
    }
    if (v & 0xf0) {
      r += 4;
      v >>= 4;
    }
    v <<= 1;
    let newHashBits = r + ((0xffffaa50 >>> v) & 0x03) + 2;
    if (newHashBits > objectHashBitsLimit) newHashBits = objectHashBitsLimit;
    const newHashSize = 1 << newHashBits;
    if (newHashSize === this.#hashSize) return;
    const newHashMask = newHashSize - 1;
    const orgCount = this.#count;
    const newSymbols = newTable(newHashSize);
    for (const d of this.#walk()) {
      const data = addTo(d.name!, newSymbols, newHashMask);
      data.slot.set(d.slot.value);
      data.symFlags &= ~(SYMBOL_HIDDEN | SYMBOL_STATIC);
      data.symFlags |= d.symFlags & (SYMBOL_HIDDEN | SYMBOL_STATIC);
      this.checkClosureAdd(data.slot.value);
    }
    this.#deleteAllMembers();
    this.#symbols = newSymbols;
    this.#hashSize = newHashSize;
    this.#hashMask = newHashMask;
    this.#count = orgCount;
  }

  #enumCallback(
    flags: number,
    callback: ObjectVariant,
    objthis: Dispatch | null,
    data: SymbolData,
    value: VariantSlot,
  ): boolean {
    let newFlags = 0;
    if (data.symFlags & SYMBOL_HIDDEN) newFlags |= TJS_HIDDENMEMBER;
    if (data.symFlags & SYMBOL_STATIC) newFlags |= TJS_STATICMEMBER;
    const args: Variant[] = [str(data.name!), int(newFlags)];
    if (!(flags & TJS_ENUM_NO_VALUE)) {
      if (failed(defaultPropGet(flags, data.slot.value, value, objthis))) return false;
      args.push(value.value);
    }
    const res = new VariantSlot();
    try {
      if (failed(closureFuncCall(callback, 0, null, res, args, null))) return false;
      return asBoolean(res.value);
    } finally {
      res.clear();
    }
  }

  override funcCall(
    flag: number,
    member: string | null,
    result: VariantSlot | null,
    args: readonly Variant[],
    objthis: Dispatch | null,
  ): number {
    if (!this.validity) return TJS_E_INVALIDOBJECT;
    if (member === null) return TJS_E_INVALIDTYPE;
    const data = this.#find(member);
    if (!data) {
      if (this.callMissing) {
        const fn = new VariantSlot();
        try {
          if (this.#callGetMissing(member, fn))
            return defaultFuncCall(flag, fn.value, result, args, objthis);
        } finally {
          fn.clear();
        }
      }
      return TJS_E_MEMBERNOTFOUND;
    }
    return defaultFuncCall(flag, data.slot.value, result, args, objthis);
  }

  override propGet(
    flag: number,
    member: string | null,
    result: VariantSlot | null,
    objthis: Dispatch | null,
  ): number {
    if (this.#rebuildHashMagic !== globalRebuildHashMagic) this.rebuildHash();
    if (!this.validity) return TJS_E_INVALIDOBJECT;
    if (member === null) return TJS_E_INVALIDTYPE;
    let data = this.#find(member);
    if (!data && this.callMissing) {
      const value = new VariantSlot();
      try {
        if (this.#callGetMissing(member, value))
          return defaultPropGet(flag, value.value, result, objthis);
      } finally {
        value.clear();
      }
    }
    if (!data && flag & TJS_MEMBERENSURE) data = this.#add(member);
    if (!data) return TJS_E_MEMBERNOTFOUND;
    return defaultPropGet(flag, data.slot.value, result, objthis);
  }

  override propSet(
    flag: number,
    member: string | null,
    value: Variant,
    objthis: Dispatch | null,
  ): number {
    if (!this.validity) return TJS_E_INVALIDOBJECT;
    if (member === null) return TJS_E_INVALIDTYPE;
    if (this.callMissing && !this.#find(member) && this.#callSetMissing(member, value))
      return TJS_S_OK;
    let data = flag & TJS_MEMBERENSURE ? this.#add(member) : this.#find(member);
    if (!data) return TJS_E_MEMBERNOTFOUND;
    if (flag & TJS_HIDDENMEMBER) data.symFlags |= SYMBOL_HIDDEN;
    else data.symFlags &= ~SYMBOL_HIDDEN;
    if (flag & TJS_STATICMEMBER) data.symFlags |= SYMBOL_STATIC;
    else data.symFlags &= ~SYMBOL_STATIC;
    if (!(flag & TJS_IGNOREPROP)) {
      const t = data.slot.value;
      if (t.type === 1 && t.object) {
        const hr = t.object.propSet(0, null, value, selectObjthis(t, objthis));
        if (succeeded(hr)) return hr;
        if (hr !== TJS_E_NOTIMPL && hr !== TJS_E_INVALIDTYPE && hr !== TJS_E_INVALIDOBJECT)
          return hr;
        data = this.#find(member);
        if (!data) return TJS_E_MEMBERNOTFOUND;
      }
    }
    this.checkClosureRemove(data.slot.value);
    data.slot.set(value);
    this.checkClosureAdd(data.slot.value);
    return TJS_S_OK;
  }

  override getCount(
    result: Out<number>,
    _member: string | null,
    _objthis: Dispatch | null,
  ): number {
    if (!this.validity) return TJS_E_INVALIDOBJECT;
    result.value = this.#count;
    return TJS_S_OK;
  }

  /**
   * Calls `callback(name, flags, value)` per member in table order until it returns false.
   * Members added or deleted during enumeration may or may not be visited, as natively.
   */
  override enumMembers(flag: number, callback: ObjectVariant, objthis: Dispatch | null): number {
    if (!this.validity) return TJS_E_INVALIDOBJECT;
    if (!callback.object) return TJS_S_OK;
    const value = new VariantSlot();
    try {
      for (const d of this.#walk())
        if (!this.#enumCallback(flag, callback, objthis, d, value)) break;
    } finally {
      value.clear();
    }
    return TJS_S_OK;
  }

  /** Member names, values and flags in enumeration order, for natives (no property calls). */
  *entries(): Generator<{name: string; value: Variant; hidden: boolean; static: boolean}> {
    for (const d of this.#walk())
      yield {
        name: d.name!,
        value: d.slot.value,
        hidden: (d.symFlags & SYMBOL_HIDDEN) !== 0,
        static: (d.symFlags & SYMBOL_STATIC) !== 0,
      };
  }

  override deleteMember(flag: number, member: string | null, _objthis: Dispatch | null): number {
    void flag;
    if (!this.validity) return TJS_E_INVALIDOBJECT;
    if (member === null) return TJS_E_MEMBERNOTFOUND;
    return this.#deleteByName(member) ? TJS_S_OK : TJS_E_MEMBERNOTFOUND;
  }

  override invalidate(flag: number, member: string | null, objthis: Dispatch | null): number {
    if (!this.validity) return TJS_E_INVALIDOBJECT;
    if (member === null) {
      if (this.#isInvalidated) return TJS_S_FALSE;
      this.#finalizeOnce();
      return TJS_S_TRUE;
    }
    const data = this.#find(member);
    if (!data && this.callMissing) {
      const value = new VariantSlot();
      try {
        if (this.#callGetMissing(member, value))
          return defaultInvalidate(flag, value.value, objthis);
      } finally {
        value.clear();
      }
    }
    if (!data) return TJS_E_MEMBERNOTFOUND;
    return defaultInvalidate(flag, data.slot.value, objthis);
  }

  override isValid(flag: number, member: string | null, objthis: Dispatch | null): number {
    if (member === null) return this.#isInvalidated ? TJS_S_FALSE : TJS_S_TRUE;
    const data = this.#find(member);
    if (!data && this.callMissing) {
      const value = new VariantSlot();
      try {
        if (this.#callGetMissing(member, value)) return defaultIsValid(flag, value.value, objthis);
      } finally {
        value.clear();
      }
    }
    if (!data) return TJS_E_MEMBERNOTFOUND;
    return defaultIsValid(flag, data.slot.value, objthis);
  }

  override createNew(
    flag: number,
    member: string | null,
    result: Out<Dispatch | null>,
    args: readonly Variant[],
    objthis: Dispatch | null,
  ): number {
    if (!this.validity) return TJS_E_INVALIDOBJECT;
    if (member === null) return TJS_E_INVALIDTYPE;
    const data = this.#find(member);
    if (!data && this.callMissing) {
      const value = new VariantSlot();
      try {
        if (this.#callGetMissing(member, value))
          return defaultCreateNew(flag, value.value, result, args, objthis);
      } finally {
        value.clear();
      }
    }
    if (!data) return TJS_E_MEMBERNOTFOUND;
    return defaultCreateNew(flag, data.slot.value, result, args, objthis);
  }

  override isInstanceOf(
    flag: number,
    member: string | null,
    className: string,
    objthis: Dispatch | null,
  ): number {
    if (!this.validity) return TJS_E_INVALIDOBJECT;
    if (member === null) {
      if (className === 'Object') return TJS_S_TRUE;
      return this.classNames.includes(className) ? TJS_S_TRUE : TJS_S_FALSE;
    }
    const data = this.#find(member);
    if (!data && this.callMissing) {
      const value = new VariantSlot();
      try {
        if (this.#callGetMissing(member, value))
          return defaultIsInstanceOf(flag, value.value, className, objthis);
      } finally {
        value.clear();
      }
    }
    if (!data) return TJS_E_MEMBERNOTFOUND;
    return defaultIsInstanceOf(flag, data.slot.value, className, objthis);
  }

  override operation(
    flag: number,
    member: string | null,
    result: VariantSlot | null,
    param: Variant | null,
    objthis: Dispatch | null,
  ): number {
    if (!this.validity) return TJS_E_INVALIDOBJECT;
    if (member === null) return TJS_E_INVALIDTYPE;
    const op = flag & TJS_OP_MASK;
    if (op !== TJS_OP_INC && op !== TJS_OP_DEC && param === null) return TJS_E_INVALIDPARAM;
    if (op < TJS_OP_MIN || op > TJS_OP_MAX) return TJS_E_INVALIDPARAM;
    const data = this.#find(member);
    if (!data && this.callMissing) return super.operation(flag, member, result, param, objthis);
    if (!data) return TJS_E_MEMBERNOTFOUND;
    const t = data.slot.value;
    if (t.type === 1 && t.object) {
      const r = propertyOperation(op, t, result, param, objthis);
      if (r !== null) return r;
    }
    this.checkClosureRemove(data.slot.value);
    try {
      data.slot.set(variantOperation(op, data.slot.value, param));
    } finally {
      this.checkClosureAdd(data.slot.value);
    }
    result?.set(data.slot.value);
    return TJS_S_OK;
  }

  override nativeInstanceSupport(
    flag: number,
    classId: number,
    pointer: Out<NativeInstance | null>,
  ): number {
    if (flag === TJS_NIS_GETINSTANCE) {
      for (let i = 0; i < TJS_MAX_NATIVE_CLASS; i++)
        if (this.#classIds[i] === classId) {
          pointer.value = this.#classInstances[i]!;
          return TJS_S_OK;
        }
      return TJS_E_FAIL;
    }
    if (flag === TJS_NIS_REGISTER) {
      for (let i = 0; i < TJS_MAX_NATIVE_CLASS; i++)
        if (this.#classIds[i] === -1) {
          this.#classIds[i] = classId;
          this.#classInstances[i] = pointer.value;
          return TJS_S_OK;
        }
      return TJS_E_FAIL;
    }
    return TJS_E_NOTIMPL;
  }

  override classInstanceInfo(flag: number, num: number, value: VariantSlot): number {
    switch (flag) {
      case TJS_CII_ADD:
        this.classNames.push(asString(value.value));
        return TJS_S_OK;
      case TJS_CII_GET:
        if (num >= this.classNames.length) return TJS_E_FAIL;
        value.set(str(this.classNames[num]!));
        return TJS_S_OK;
      case TJS_CII_SET_FINALIZE:
        this.finalizeName = asString(value.value);
        this.callFinalize = this.finalizeName !== '';
        return TJS_S_OK;
      case TJS_CII_SET_MISSING:
        this.missingName = asString(value.value);
        this.callMissing = this.missingName !== '';
        return TJS_S_OK;
    }
    return TJS_E_NOTIMPL;
  }
}

function newTable(size: number): SymbolData[] {
  const t: SymbolData[] = [];
  for (let i = 0; i < size; i++) t.push(new SymbolData());
  return t;
}

/** `AddTo`: adds a member to a new table during `RebuildHash` (count unchanged). */
function addTo(name: string, symbols: SymbolData[], mask: number): SymbolData {
  const hash = tjsHash(name);
  const lv1 = symbols[hash & mask]!;
  if (lv1.symFlags & SYMBOL_USING) {
    const data = new SymbolData();
    data.selfClear();
    data.next = lv1.next;
    lv1.next = data;
    data.setName(name, hash);
    data.symFlags |= SYMBOL_USING;
    return data;
  }
  if (!(lv1.symFlags & SYMBOL_INIT)) lv1.selfClear();
  lv1.setName(name, hash);
  lv1.symFlags |= SYMBOL_USING;
  return lv1;
}

/** `TJSCreateCustomObject`. */
export function createCustomObject(): CustomObject {
  return new CustomObject();
}

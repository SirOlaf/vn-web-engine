/**
 * The `Array` class (krkrz `tjsArray.cpp`). An array object is a custom object whose numeric
 * member names address elements; other names are ordinary members. Elements hold references
 * like members do, including the rule that a closure bound to the array itself holds none.
 */
import {
  closureFuncCall,
  defaultCreateNew,
  defaultFuncCall,
  defaultInvalidate,
  defaultIsInstanceOf,
  defaultIsValid,
  defaultOperation,
  defaultPropGet,
  defaultPropSet,
} from '../dispatch.js';
import {CustomObject} from '../custom-object.js';
import {check, throwTjsError, TjsError, tjsMessage} from '../errors.js';
import {
  failed,
  succeeded,
  TJS_E_BADPARAMCOUNT,
  TJS_E_INVALIDOBJECT,
  TJS_E_MEMBERNOTFOUND,
  TJS_E_NATIVECLASSCRASH,
  TJS_E_NOTIMPL,
  TJS_E_SUSPENDED,
  TJS_HIDDENMEMBER,
  TJS_IGNOREPROP,
  TJS_MEMBERMUSTEXIST,
  TJS_NIS_GETINSTANCE,
  TJS_S_OK,
  type Dispatch,
  type NativeInstance,
  type Out,
} from '../interface.js';
import {
  constructNativeInstance,
  findNativeClassId,
  NativeClass,
  NativeFunction,
  NativeInstanceBase,
  registerNativeClass,
} from '../native.js';
import {addRefVariant, releaseVariant, VariantSlot, type VariantCell} from '../slot.js';
import {
  asBoolean,
  asInt32,
  asInteger,
  asObjectClosure,
  asString,
  compareStrings,
  discernCompare,
  expressionString,
  greaterThan,
  int,
  integer,
  littlerThan,
  obj,
  NULL_OBJECT,
  str,
  toNumber,
  VOID,
  type ObjectVariant,
  type Variant,
} from '../variant.js';
import {escapeC} from '../../literals.js';
import {msvcSort, msvcStableSort} from '../msvc-sort.js';
import type {TjsEngine, TjsTextWriter} from '../engine.js';
import {DICTIONARY_CLASS_ID, DictionaryNI} from './dictionary.js';

const TJS_ARRAY_BASE_HASH_BITS = 3;
export const ARRAY_CLASS_ID = registerNativeClass('Array');

/** `TJS_iswspace`: C-locale `isspace` below 0x100. */
function isSpace(c: number): boolean {
  return c === 0x20 || (c >= 0x09 && c <= 0x0d);
}
function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

/** `_wtoi`: leading spaces, a sign, digits; clamps to the 32-bit range. */
function atoi(s: string): number {
  let i = 0;
  while (i < s.length && isSpace(s.charCodeAt(i))) i++;
  let negative = false;
  if (s[i] === '-' || s[i] === '+') negative = s[i++] === '-';
  let v = 0;
  for (; i < s.length && isDigit(s.charCodeAt(i)); i++) v = v * 10 + (s.charCodeAt(i) - 0x30);
  v = negative ? -v : v;
  return v > 0x7fffffff ? 0x7fffffff : v < -0x80000000 ? -0x80000000 : v;
}

/** `IsNumber`: a member name that addresses an element. */
function isNumber(s: string): number | null {
  if (!s) return null;
  let i = 0,
    org = 0;
  while (i < s.length && isSpace(s.charCodeAt(i))) i++;
  if (i >= s.length) return null;
  if (s[i] === '-') i++;
  else if (s[i] === '+') org = ++i;
  if (i >= s.length) return null;
  while (i < s.length && isSpace(s.charCodeAt(i))) i++;
  if (i >= s.length || !isDigit(s.charCodeAt(i))) return null;
  while (i < s.length && (isDigit(s.charCodeAt(i)) || s[i] === '.')) i++;
  while (i < s.length && isSpace(s.charCodeAt(i))) i++;
  return i === s.length ? atoi(s.slice(org)) : null;
}

/** `tTJSArrayNI`: the element store. Elements hold references (see `ArrayObject`). */
export class ArrayNI extends NativeInstanceBase {
  items: Variant[] = [];

  override construct(args: readonly Variant[]): number {
    return args.length !== 0 ? TJS_E_BADPARAMCOUNT : TJS_S_OK;
  }

  /** `SaveStructuredData`: `(const) [ … ]` with one-space indentation steps and CR LF. */
  saveStructuredData(stack: Dispatch[], out: TjsTextWriter, indent: string): void {
    out.write('(const) [\r\n');
    const indent2 = indent + ' ';
    const n = this.items.length;
    for (let c = 0; c < this.items.length; c++) {
      const v = this.items[c]!;
      out.write(indent2);
      if (v.type === 1) saveStructuredDataForObject(v.objthis ?? v.object, stack, out, indent2);
      else out.write(expressionString(v));
      out.write(c !== n - 1 ? ',\r\n' : '\r\n');
    }
    out.write(indent);
    out.write(']');
  }
}

/** `tTJSArrayNI::SaveStructuredDataForObject`: nested arrays and dictionaries; others as null. */
export function saveStructuredDataForObject(
  dsp: Dispatch | null,
  stack: Dispatch[],
  out: TjsTextWriter,
  indent: string,
): void {
  if (dsp && stack.includes(dsp)) {
    out.write('null /* object recursion detected */');
    return;
  }
  const dic = dsp ? instanceOf<DictionaryNI>(dsp, DICTIONARY_CLASS_ID) : null;
  if (dsp && dic) {
    stack.push(dsp);
    dic.saveStructuredData(stack, out, indent);
    stack.pop();
    return;
  }
  const arr = dsp ? instanceOf<ArrayNI>(dsp, ARRAY_CLASS_ID) : null;
  if (dsp && arr) {
    stack.push(dsp);
    arr.saveStructuredData(stack, out, indent);
    stack.pop();
    return;
  }
  if (dsp) {
    out.write('null /* (object) "');
    out.write(escapeC(asString(obj(dsp, dsp))));
    out.write('" */');
    return;
  }
  out.write('null');
}

export function instanceOf<T extends NativeInstance>(dsp: Dispatch, classId: number): T | null {
  const p: Out<NativeInstance | null> = {value: null};
  if (failed(dsp.nativeInstanceSupport(TJS_NIS_GETINSTANCE, classId, p))) return null;
  return p.value as T | null;
}

/** `tTJSArrayObject`. */
export class ArrayObject extends CustomObject {
  constructor() {
    super(TJS_ARRAY_BASE_HASH_BITS);
    this.callFinalize = false;
  }

  get ni(): ArrayNI {
    const ni = instanceOf<ArrayNI>(this, ARRAY_CLASS_ID);
    if (!ni) throwTjsError('TJSNativeClassCrash');
    return ni;
  }

  protected override finalize(): void {
    const ni = instanceOf<ArrayNI>(this, ARRAY_CLASS_ID);
    if (!ni) throwTjsError('TJSNativeClassCrash');
    this.clearItems(ni);
    super.finalize();
  }

  /** `Clear`: drops every element; objects are released after the store is empty. */
  clearItems(ni: ArrayNI): void {
    const held: Variant[] = [];
    for (const v of ni.items) {
      if (v.type === 1) {
        this.checkClosureRemove(v);
        held.push(v);
      }
    }
    ni.items = [];
    for (const v of held) releaseVariant(v);
  }

  /** Stores a copy of `v` at the end (`Add`). */
  addItem(ni: ArrayNI, v: Variant): void {
    addRefVariant(v);
    ni.items.push(v);
    this.checkClosureAdd(v);
  }

  /** `Remove`: removes the first or every element `===` to `ref`; returns the count. */
  removeItems(ni: ArrayNI, ref: Variant, removeAll: boolean): number {
    const toDelete: number[] = [];
    ni.items.forEach((v, i) => {
      if (toDelete.length && !removeAll) return;
      if (discernCompare(ref, v)) toDelete.push(i);
    });
    const held: Variant[] = [];
    for (const i of toDelete) {
      const v = ni.items[i]!;
      if (v.type === 1) {
        this.checkClosureRemove(v);
        held.push(v);
        ni.items[i] = VOID;
      }
    }
    for (let k = toDelete.length - 1; k >= 0; k--) ni.items.splice(toDelete[k]!, 1);
    for (const v of held) releaseVariant(v);
    return toDelete.length;
  }

  eraseItem(ni: ArrayNI, num: number): void {
    if (num < 0) num += ni.items.length;
    if (num < 0 || num >= ni.items.length) throwTjsError('TJSRangeError');
    const v = ni.items[num]!;
    this.checkClosureRemove(v);
    ni.items.splice(num, 1);
    releaseVariant(v);
  }

  insertItems(ni: ArrayNI, values: readonly Variant[], num: number): void {
    if (num < 0) num += ni.items.length;
    if (num < 0) throwTjsError('TJSRangeError');
    if (num > ni.items.length) throwTjsError('TJSRangeError');
    for (const v of values) addRefVariant(v);
    ni.items.splice(num, 0, ...values);
    for (const v of values) this.checkClosureAdd(v);
  }

  /** `Items.resize`: new elements are void. */
  resizeItems(ni: ArrayNI, count: number): void {
    if (count < 0 || count > 0x7fffffff) throwTjsError('TJSInsufficientMem');
    if (count < ni.items.length) {
      const removed = ni.items.splice(count);
      for (const v of removed) {
        this.checkClosureRemove(v);
        releaseVariant(v);
      }
    } else while (ni.items.length < count) ni.items.push(VOID);
  }

  #cell(ni: ArrayNI, num: number): VariantCell {
    const items = ni.items;
    return {
      get value() {
        return items[num] ?? VOID;
      },
      set(v: Variant) {
        addRefVariant(v);
        const old = items[num] ?? VOID;
        items[num] = v;
        releaseVariant(old);
      },
    };
  }

  /** `ARRAY_GET_VAL`: a held copy of an element, void past the end; null when it must exist. */
  #element(ni: ArrayNI, flag: number, num: number): Variant | null {
    const count = ni.items.length;
    if (num < 0) num = count + num;
    if (flag & TJS_MEMBERMUSTEXIST && (num < 0 || count <= num)) return null;
    return count <= num || num < 0 ? VOID : ni.items[num]!;
  }

  #withElement(flag: number, num: number, fn: (v: Variant) => number): number {
    if (!this.validity) return TJS_E_INVALIDOBJECT;
    const ni = instanceOf<ArrayNI>(this, ARRAY_CLASS_ID);
    if (!ni) return TJS_E_NATIVECLASSCRASH;
    const v = this.#element(ni, flag, num);
    if (!v) return TJS_E_MEMBERNOTFOUND;
    addRefVariant(v);
    try {
      return fn(v);
    } finally {
      releaseVariant(v);
    }
  }

  /** `PropSetByNum`/`OperationByNum`: grows the store when writing past the end. */
  #withCell(flag: number, num: number, fn: (cell: VariantCell) => number): number {
    if (!this.validity) return TJS_E_INVALIDOBJECT;
    const ni = instanceOf<ArrayNI>(this, ARRAY_CLASS_ID);
    if (!ni) return TJS_E_NATIVECLASSCRASH;
    if (num < 0) num += ni.items.length;
    if (num >= ni.items.length) {
      if (flag & TJS_MEMBERMUSTEXIST) return TJS_E_MEMBERNOTFOUND;
      this.resizeItems(ni, num + 1);
    }
    if (num < 0) return TJS_E_MEMBERNOTFOUND;
    const cell = this.#cell(ni, num);
    this.checkClosureRemove(cell.value);
    try {
      return fn(cell);
    } finally {
      this.checkClosureAdd(cell.value);
    }
  }

  override funcCall(
    flag: number,
    member: string | null,
    result: VariantSlot | null,
    args: readonly Variant[],
    objthis: Dispatch | null,
  ): number {
    const idx = member !== null ? isNumber(member) : null;
    if (idx !== null) return this.funcCallByNum(flag, idx, result, args, objthis);
    return super.funcCall(flag, member, result, args, objthis);
  }
  override funcCallByNum(
    flag: number,
    num: number,
    result: VariantSlot | null,
    args: readonly Variant[],
    objthis: Dispatch | null,
  ): number {
    return this.#withElement(flag, num, (v) => defaultFuncCall(flag, v, result, args, objthis));
  }
  override propGet(
    flag: number,
    member: string | null,
    result: VariantSlot | null,
    objthis: Dispatch | null,
  ): number {
    const idx = member !== null ? isNumber(member) : null;
    if (idx !== null) return this.propGetByNum(flag, idx, result, objthis);
    return super.propGet(flag, member, result, objthis);
  }
  override propGetByNum(
    flag: number,
    num: number,
    result: VariantSlot | null,
    objthis: Dispatch | null,
  ): number {
    return this.#withElement(flag, num, (v) => defaultPropGet(flag, v, result, objthis));
  }
  override propSet(
    flag: number,
    member: string | null,
    value: Variant,
    objthis: Dispatch | null,
  ): number {
    const idx = member !== null ? isNumber(member) : null;
    if (idx !== null) return this.propSetByNum(flag, idx, value, objthis);
    return super.propSet(flag, member, value, objthis);
  }
  override propSetByNum(
    flag: number,
    num: number,
    value: Variant,
    objthis: Dispatch | null,
  ): number {
    return this.#withCell(flag, num, (cell) => defaultPropSet(flag, cell, value, objthis));
  }
  override deleteMember(flag: number, member: string | null, objthis: Dispatch | null): number {
    const idx = member !== null ? isNumber(member) : null;
    if (idx !== null) return this.deleteMemberByNum(flag, idx, objthis);
    return super.deleteMember(flag, member, objthis);
  }
  override deleteMemberByNum(_flag: number, num: number, _objthis: Dispatch | null): number {
    if (!this.validity) return TJS_E_INVALIDOBJECT;
    const ni = instanceOf<ArrayNI>(this, ARRAY_CLASS_ID);
    if (!ni) return TJS_E_NATIVECLASSCRASH;
    if (num < 0) num += ni.items.length;
    if (num < 0 || num >= ni.items.length) return TJS_E_MEMBERNOTFOUND;
    const v = ni.items[num]!;
    this.checkClosureRemove(v);
    ni.items.splice(num, 1);
    releaseVariant(v);
    return TJS_S_OK;
  }
  override invalidate(flag: number, member: string | null, objthis: Dispatch | null): number {
    const idx = member !== null ? isNumber(member) : null;
    if (idx !== null) return this.invalidateByNum(flag, idx, objthis);
    return super.invalidate(flag, member, objthis);
  }
  override invalidateByNum(flag: number, num: number, objthis: Dispatch | null): number {
    return this.#withElement(flag, num, (v) => defaultInvalidate(flag, v, objthis));
  }
  override isValid(flag: number, member: string | null, objthis: Dispatch | null): number {
    const idx = member !== null ? isNumber(member) : null;
    if (idx !== null) return this.isValidByNum(flag, idx, objthis);
    return super.isValid(flag, member, objthis);
  }
  override isValidByNum(flag: number, num: number, objthis: Dispatch | null): number {
    return this.#withElement(flag, num, (v) => defaultIsValid(flag, v, objthis));
  }
  override createNew(
    flag: number,
    member: string | null,
    result: Out<Dispatch | null>,
    args: readonly Variant[],
    objthis: Dispatch | null,
  ): number {
    const idx = member !== null ? isNumber(member) : null;
    if (idx !== null) return this.createNewByNum(flag, idx, result, args, objthis);
    return super.createNew(flag, member, result, args, objthis);
  }
  override createNewByNum(
    flag: number,
    num: number,
    result: Out<Dispatch | null>,
    args: readonly Variant[],
    objthis: Dispatch | null,
  ): number {
    return this.#withElement(flag, num, (v) => defaultCreateNew(flag, v, result, args, objthis));
  }
  override isInstanceOf(
    flag: number,
    member: string | null,
    className: string,
    objthis: Dispatch | null,
  ): number {
    const idx = member !== null ? isNumber(member) : null;
    if (idx !== null) return this.isInstanceOfByNum(flag, idx, className, objthis);
    return super.isInstanceOf(flag, member, className, objthis);
  }
  override isInstanceOfByNum(
    flag: number,
    num: number,
    className: string,
    objthis: Dispatch | null,
  ): number {
    return this.#withElement(flag, num, (v) => defaultIsInstanceOf(flag, v, className, objthis));
  }
  override operation(
    flag: number,
    member: string | null,
    result: VariantSlot | null,
    param: Variant | null,
    objthis: Dispatch | null,
  ): number {
    const idx = member !== null ? isNumber(member) : null;
    if (idx !== null) return this.operationByNum(flag, idx, result, param, objthis);
    return super.operation(flag, member, result, param, objthis);
  }
  override operationByNum(
    flag: number,
    num: number,
    result: VariantSlot | null,
    param: Variant | null,
    objthis: Dispatch | null,
  ): number {
    return this.#withCell(flag, num, (cell) =>
      defaultOperation(flag, cell, result, param, objthis),
    );
  }
}

/** A RegExp native instance as `Array.split` uses it. */
export interface ArraySplitter {
  split(array: ArrayObject, target: string, purgeEmpty: boolean): void;
}

type Less = (a: Variant, b: Variant) => boolean;

function numericLess(desc: boolean): Less {
  return (l, r) => {
    if (l.type === 2 && r.type === 2) {
      const a = toNumber(l),
        b = toNumber(r);
      return desc ? littlerThan(a, b) : greaterThan(a, b);
    }
    return desc ? littlerThan(l, r) : greaterThan(l, r);
  };
}
function stringLess(desc: boolean): Less {
  return (l, r) => {
    if (l.type === 2 && r.type === 2) return desc ? littlerThan(l, r) : greaterThan(l, r);
    const c = compareStrings(asString(l), asString(r));
    return desc ? c > 0 : c < 0;
  };
}

/** `tTJSArrayClass`. Natives reach elements through `ArrayObject` and `ArrayNI`. */
export class ArrayClass extends NativeClass {
  constructor(private readonly engine: TjsEngine) {
    super('Array', () => new ArrayNI());
    const self = this;
    const ni = (objthis: Dispatch) => instanceOf<ArrayNI>(objthis, ARRAY_CLASS_ID);
    // Natively `objthis` is cast to tTJSArrayObject whatever it is; the element methods only
    // use what every custom object has, so instances of script classes extending Array work.
    const arr = (objthis: Dispatch): ArrayObject => {
      if (objthis instanceof ArrayObject) return objthis;
      if (!(objthis instanceof CustomObject)) return throwTjsError('TJSNativeClassCrash');
      const p = ArrayObject.prototype;
      return {
        clearItems: (n: ArrayNI) => p.clearItems.call(objthis as ArrayObject, n),
        addItem: (n: ArrayNI, v: Variant) => p.addItem.call(objthis as ArrayObject, n, v),
        removeItems: (n: ArrayNI, ref: Variant, all: boolean) =>
          p.removeItems.call(objthis as ArrayObject, n, ref, all),
        eraseItem: (n: ArrayNI, num: number) => p.eraseItem.call(objthis as ArrayObject, n, num),
        insertItems: (n: ArrayNI, values: readonly Variant[], num: number) =>
          p.insertItems.call(objthis as ArrayObject, n, values, num),
        resizeItems: (n: ArrayNI, count: number) =>
          p.resizeItems.call(objthis as ArrayObject, n, count),
      } as unknown as ArrayObject;
    };

    this.constructorMethod((_result, args, objthis) => {
      const r = constructNativeInstance(self, args, objthis);
      return typeof r === 'number' ? r : TJS_S_OK;
    });

    this.method('load', (result, args, objthis) => {
      const a = ni(objthis);
      if (!a) return TJS_E_NATIVECLASSCRASH;
      if (args.length < 1) return TJS_E_BADPARAMCOUNT;
      const name = asString(args[0]!);
      const mode = args.length >= 2 && args[1]!.type !== 0 ? asString(args[1]!) : '';
      const finish = (content: string) => {
        arr(objthis).clearItems(a);
        for (const line of splitLines(content)) a.items.push(str(line));
        result?.set(obj(objthis, objthis));
        return TJS_S_OK;
      };
      const text = engine.host.readText(name, mode);
      if (typeof text === 'string') return finish(text);
      return engine.suspender.suspend(text, finish);
    });

    this.method('loadStruct', () => TJS_E_NOTIMPL); // binary serializer: not ported yet

    this.method('save', (result, args, objthis) => {
      const a = ni(objthis);
      if (!a) return TJS_E_NATIVECLASSCRASH;
      if (args.length < 1) return TJS_E_BADPARAMCOUNT;
      const mode = args.length >= 2 && args[1]!.type !== 0 ? asString(args[1]!) : '';
      const out = engine.host.openTextWrite(asString(args[0]!), mode);
      try {
        for (const v of a.items) {
          if (v.type === 2 || v.type === 4 || v.type === 5) out.write(asString(v));
          out.write('\r\n');
        }
      } finally {
        out.close();
      }
      result?.set(obj(objthis, objthis));
      return TJS_S_OK;
    });

    this.method('saveStruct', (result, args, objthis) => {
      const a = ni(objthis);
      if (!a) return TJS_E_NATIVECLASSCRASH;
      if (args.length < 1) return TJS_E_BADPARAMCOUNT;
      const mode = args.length >= 2 && args[1]!.type !== 0 ? asString(args[1]!) : '';
      if (mode.includes('b')) return TJS_E_NOTIMPL; // binary serializer: not ported yet
      const out = engine.host.openTextWrite(asString(args[0]!), mode);
      try {
        a.saveStructuredData([objthis], out, '');
      } finally {
        out.close();
      }
      result?.set(obj(objthis, objthis));
      return TJS_S_OK;
    });

    this.method('split', (result, args, objthis) => {
      const a = ni(objthis);
      if (!a) return TJS_E_NATIVECLASSCRASH;
      if (args.length < 2) return TJS_E_BADPARAMCOUNT;
      arr(objthis).resizeItems(a, 0);
      const target = asString(args[1]!);
      const purgeEmpty = args.length >= 4 && args[3]!.type !== 0 ? asBoolean(args[3]!) : false;
      const pattern = args[0]!;
      if (pattern.type === 1 && pattern.object) {
        const id = findNativeClassId('RegExp');
        const re = id >= 0 ? instanceOf<NativeInstance & ArraySplitter>(pattern.object, id) : null;
        if (re) {
          re.split(arr(objthis), target, purgeEmpty);
          result?.set(obj(objthis, objthis));
          return TJS_S_OK;
        }
      }
      const delimiters = asString(pattern);
      let start = 0,
        i = 0;
      // TJS_strchr also matches the terminating NUL; strings here stop at their end.
      for (; i < target.length; i++) {
        if (target[i] === '\0') break;
        if (delimiters.includes(target[i]!)) {
          if (!purgeEmpty || i - start !== 0) a.items.push(str(target.slice(start, i)));
          start = i + 1;
        }
      }
      if (!purgeEmpty || i - start !== 0) a.items.push(str(target.slice(start, i)));
      result?.set(obj(objthis, objthis));
      return TJS_S_OK;
    });

    this.method('join', (result, args, objthis) => {
      const a = ni(objthis);
      if (!a) return TJS_E_NATIVECLASSCRASH;
      if (args.length < 1) return TJS_E_BADPARAMCOUNT;
      const delimiter = asString(args[0]!);
      const purgeEmpty = args.length >= 3 && args[2]!.type !== 0 ? asBoolean(args[2]!) : false;
      let out = '',
        first = true;
      for (const v of a.items) {
        if (purgeEmpty && v.type === 0) continue;
        if (!first) out += delimiter;
        first = false;
        out += asString(v);
      }
      result?.set(str(out));
      return TJS_S_OK;
    });

    this.method('sort', (_result, args, objthis) => {
      const a = ni(objthis);
      if (!a) return TJS_E_NATIVECLASSCRASH;
      let method = '+';
      let closure: ObjectVariant | null = null;
      if (args.length >= 1 && args[0]!.type !== 0) {
        if (args[0]!.type === 1) {
          closure = asObjectClosure(args[0]!);
          method = '';
        } else {
          method = asString(args[0]!)[0] ?? '';
          if (!'+-09az'.includes(method) || method === '') method = '+';
        }
      }
      const stable = args.length >= 2 && args[1]!.type !== 0 ? asBoolean(args[1]!) : false;
      let less: Less;
      switch (method) {
        case '-':
          less = littlerThan;
          break;
        case '0':
          less = numericLess(false);
          break;
        case '9':
          less = numericLess(true);
          break;
        case 'a':
          less = stringLess(false);
          break;
        case 'z':
          less = stringLess(true);
          break;
        case '':
          less = (l, r) => {
            const res = new VariantSlot();
            try {
              check(closureFuncCall(closure!, 0, null, res, [l, r], null));
              return asBoolean(res.value);
            } finally {
              res.clear();
            }
          };
          break;
        default:
          less = greaterThan;
      }
      engine.suspender.nonSuspending(() => (stable ? msvcStableSort : msvcSort)(a.items, less));
      return TJS_S_OK;
    });

    this.method('reverse', (_result, _args, objthis) => {
      const a = ni(objthis);
      if (!a) return TJS_E_NATIVECLASSCRASH;
      a.items.reverse();
      return TJS_S_OK;
    });

    this.method('assign', (_result, args, objthis) => {
      const a = ni(objthis);
      if (!a) return TJS_E_NATIVECLASSCRASH;
      if (args.length < 1) return TJS_E_BADPARAMCOUNT;
      arr(objthis).clearItems(a);
      const clo = asObjectClosure(args[0]!);
      const src = clo.objthis ?? clo.object ?? throwTjsError('TJSNullAccess');
      self.assign(arr(objthis), a, src);
      return TJS_S_OK;
    });

    this.method('assignStruct', (_result, args, objthis) => {
      const a = ni(objthis);
      if (!a) return TJS_E_NATIVECLASSCRASH;
      if (args.length < 1) return TJS_E_BADPARAMCOUNT;
      arr(objthis).clearItems(a);
      const clo = asObjectClosure(args[0]!);
      const src = clo.objthis ?? clo.object ?? throwTjsError('TJSNullAccess');
      self.assignStructure(arr(objthis), a, src, []);
      return TJS_S_OK;
    });

    this.method('clear', (_result, _args, objthis) => {
      const a = ni(objthis);
      if (!a) return TJS_E_NATIVECLASSCRASH;
      arr(objthis).clearItems(a);
      return TJS_S_OK;
    });

    this.method('erase', (_result, args, objthis) => {
      const a = ni(objthis);
      if (!a) return TJS_E_NATIVECLASSCRASH;
      if (args.length < 1) return TJS_E_BADPARAMCOUNT;
      arr(objthis).eraseItem(a, asInt32(args[0]!));
      return TJS_S_OK;
    });

    this.method('remove', (result, args, objthis) => {
      const a = ni(objthis);
      if (!a) return TJS_E_NATIVECLASSCRASH;
      if (args.length < 1) return TJS_E_BADPARAMCOUNT;
      const removeAll = args.length >= 2 ? asBoolean(args[1]!) : true;
      result?.set(int(arr(objthis).removeItems(a, args[0]!, removeAll)));
      return TJS_S_OK;
    });

    this.method('insert', (_result, args, objthis) => {
      const a = ni(objthis);
      if (!a) return TJS_E_NATIVECLASSCRASH;
      if (args.length < 2) return TJS_E_BADPARAMCOUNT;
      arr(objthis).insertItems(a, [args[1]!], asInt32(args[0]!));
      return TJS_S_OK;
    });

    this.method('add', (result, args, objthis) => {
      const a = ni(objthis);
      if (!a) return TJS_E_NATIVECLASSCRASH;
      if (args.length < 1) return TJS_E_BADPARAMCOUNT;
      arr(objthis).addItem(a, args[0]!);
      result?.set(int(a.items.length - 1));
      return TJS_S_OK;
    });

    this.method('push', (result, args, objthis) => {
      const a = ni(objthis);
      if (!a) return TJS_E_NATIVECLASSCRASH;
      arr(objthis).insertItems(a, args, a.items.length);
      result?.set(int(a.items.length));
      return TJS_S_OK;
    });

    const takeAt =
      (end: boolean) =>
      (result: VariantSlot | null, _args: readonly Variant[], objthis: Dispatch) => {
        const a = ni(objthis);
        if (!a) return TJS_E_NATIVECLASSCRASH;
        if (a.items.length === 0) result?.clear();
        else {
          const i = end ? a.items.length - 1 : 0;
          result?.set(a.items[i]!);
          arr(objthis).eraseItem(a, i);
        }
        return TJS_S_OK;
      };
    this.method('pop', takeAt(true));
    this.method('shift', takeAt(false));

    this.method('unshift', (result, args, objthis) => {
      const a = ni(objthis);
      if (!a) return TJS_E_NATIVECLASSCRASH;
      arr(objthis).insertItems(a, args, 0);
      result?.set(int(a.items.length));
      return TJS_S_OK;
    });

    this.method('find', (result, args, objthis) => {
      const a = ni(objthis);
      if (!a) return TJS_E_NATIVECLASSCRASH;
      if (args.length < 1) return TJS_E_BADPARAMCOUNT;
      if (!result) return TJS_S_OK;
      let start = args.length >= 2 ? asInt32(args[1]!) : 0;
      if (start < 0) start += a.items.length;
      if (start < 0) start = 0;
      let found = -1;
      for (let i = start; i < a.items.length; i++)
        if (discernCompare(args[0]!, a.items[i]!)) {
          found = i;
          break;
        }
      result.set(int(found));
      return TJS_S_OK;
    });

    this.method('pack', () => TJS_E_NOTIMPL); // TJSOctetPack: not ported yet

    const count = {
      get: (result: VariantSlot, objthis: Dispatch) => {
        const a = ni(objthis);
        if (!a) return TJS_E_NATIVECLASSCRASH;
        result.set(int(a.items.length));
        return TJS_S_OK;
      },
      set: (value: Variant, objthis: Dispatch) => {
        const a = ni(objthis);
        if (!a) return TJS_E_NATIVECLASSCRASH;
        arr(objthis).resizeItems(a, Number(BigInt.asUintN(32, asInteger(value))));
        return TJS_S_OK;
      },
    };
    this.property('count', count);
    this.property('length', count);
  }

  protected override createBaseObject(): CustomObject {
    return new ArrayObject();
  }

  /** `tTJSArrayNI::Assign`: from an array, or name/value pairs of other objects' members. */
  assign(target: ArrayObject, ni: ArrayNI, src: Dispatch): void {
    const other = instanceOf<ArrayNI>(src, ARRAY_CLASS_ID);
    if (other) {
      target.clearItems(ni);
      for (const v of other.items) target.addItem(ni, v);
      return;
    }
    target.clearItems(ni);
    const cb = new NativeFunction((result, args) => {
      if (args.length < 3) return TJS_E_BADPARAMCOUNT;
      if (!(asInt32(args[1]!) & TJS_HIDDENMEMBER)) {
        target.addItem(ni, args[0]!);
        target.addItem(ni, args[2]!);
      }
      result?.set(int(1));
      return TJS_S_OK;
    });
    try {
      src.enumMembers(TJS_IGNOREPROP, obj(cb), src);
    } finally {
      cb.release();
    }
  }

  /** `AssignStructure`: deep copy of nested arrays and dictionaries. */
  assignStructure(target: ArrayObject, ni: ArrayNI, src: Dispatch, stack: Dispatch[]): void {
    const other = instanceOf<ArrayNI>(src, ARRAY_CLASS_ID);
    if (!other) throwTjsError('TJSSpecifyDicOrArray');
    stack.push(src);
    try {
      target.clearItems(ni);
      for (const v of [...other.items]) {
        const copy = this.engine.newStructuredCopy(v, stack);
        if (!copy) {
          target.addItem(ni, v);
          continue;
        }
        // Stored first, then filled, as natively: the element holds the new object.
        target.addItem(ni, copy.value);
        copy.object?.release();
        copy.fill();
      }
    } finally {
      stack.pop();
    }
  }
}

/** Splits text into lines at CR, LF and CR LF; a trailing empty line is not added. */
function splitLines(content: string): string[] {
  const lines: string[] = [];
  let start = 0;
  let i = 0;
  for (; i < content.length; i++) {
    const c = content[i];
    if (c === '\0') break;
    if (c === '\r' || c === '\n') {
      lines.push(content.slice(start, i));
      if (c === '\r' && content[i + 1] === '\n') i++;
      start = i + 1;
    }
  }
  if (i - start) lines.push(content.slice(start, i));
  return lines;
}

/**
 * The `Dictionary` class (krkrz `tjsDictionary.cpp`). A dictionary is a custom object whose
 * missing members read as void. Its methods are static class members, called as
 * `(Dictionary.assign incontextof d)(src)`; they are not copied into instances.
 */
import {CustomObject} from '../custom-object.js';
import {throwTjsError} from '../errors.js';
import {
  TJS_E_BADPARAMCOUNT,
  TJS_E_INVALIDOBJECT,
  TJS_E_INVALIDTYPE,
  TJS_E_MEMBERNOTFOUND,
  TJS_E_NATIVECLASSCRASH,
  TJS_E_NOTIMPL,
  TJS_HIDDENMEMBER,
  TJS_IGNOREPROP,
  TJS_MEMBERENSURE,
  TJS_MEMBERMUSTEXIST,
  TJS_S_OK,
  TJS_STATICMEMBER,
  type Dispatch,
  type Out,
} from '../interface.js';
import {
  constructNativeInstance,
  NativeClass,
  NativeFunction,
  NativeInstanceBase,
  registerNativeClass,
} from '../native.js';
import type {VariantSlot} from '../slot.js';
import {
  asInt32,
  asObjectClosure,
  asString,
  expressionString,
  int,
  obj,
  VOID,
  type Variant,
} from '../variant.js';
import {escapeC} from '../../literals.js';
import type {TjsEngine, TjsTextWriter} from '../engine.js';
import {ARRAY_CLASS_ID, ArrayNI, instanceOf, saveStructuredDataForObject} from './array.js';

export const DICTIONARY_CLASS_ID = registerNativeClass('Dictionary');

/** Calls `fn(name, flags, value)` for every member, as `EnumMembers(TJS_IGNOREPROP)` does. */
export function forEachMember(
  dsp: Dispatch,
  fn: (name: string, flags: number, value: Variant) => void,
): void {
  const cb = new NativeFunction((result, args) => {
    if (args.length < 3) return TJS_E_BADPARAMCOUNT;
    fn(asString(args[0]!), asInt32(args[1]!), args[2]!);
    result?.set(int(1));
    return TJS_S_OK;
  });
  try {
    dsp.enumMembers(TJS_IGNOREPROP, obj(cb), dsp);
  } finally {
    cb.release();
  }
}

/** `tTJSDictionaryNI`. `owner` is cleared on invalidation. */
export class DictionaryNI extends NativeInstanceBase {
  owner: CustomObject | null = null;

  override construct(args: readonly Variant[], owner: Dispatch): number {
    if (args.length > 1) return TJS_E_BADPARAMCOUNT;
    this.owner = owner as CustomObject;
    return TJS_S_OK;
  }
  override invalidate(): void {
    this.owner = null;
  }
  get valid(): boolean {
    return this.owner !== null;
  }

  /** `SaveStructuredData`: `(const) %[ "name" => value, … ]`, hidden members skipped. */
  saveStructuredData(stack: Dispatch[], out: TjsTextWriter, indent: string): void {
    out.write('(const) %[\r\n');
    const indent2 = indent + ' ';
    let first = true;
    forEachMember(this.owner!, (name, flags, value) => {
      if (flags & TJS_HIDDENMEMBER) return;
      if (!first) out.write(',\r\n');
      first = false;
      out.write(indent2);
      out.write('"');
      out.write(escapeC(name));
      out.write('" => ');
      if (value.type === 1)
        saveStructuredDataForObject(value.objthis ?? value.object, stack, out, indent2);
      else out.write(expressionString(value));
    });
    if (!first) out.write('\r\n');
    out.write(indent);
    out.write(']');
  }
}

/** `tTJSDictionaryObject`: missing members read as void instead of failing. */
export class DictionaryObject extends CustomObject {
  constructor(hashBits?: number) {
    super(hashBits);
    this.callFinalize = false;
  }

  override propGet(
    flag: number,
    member: string | null,
    result: VariantSlot | null,
    objthis: Dispatch | null,
  ): number {
    const hr = super.propGet(flag, member, result, objthis);
    if (hr === TJS_E_MEMBERNOTFOUND && !(flag & TJS_MEMBERMUSTEXIST)) {
      result?.clear();
      return TJS_S_OK;
    }
    return hr;
  }

  override createNew(
    flag: number,
    member: string | null,
    result: Out<Dispatch | null>,
    args: readonly Variant[],
    objthis: Dispatch | null,
  ): number {
    const hr = super.createNew(flag, member, result, args, objthis);
    if (hr === TJS_E_MEMBERNOTFOUND && !(flag & TJS_MEMBERMUSTEXIST)) return TJS_E_INVALIDTYPE;
    return hr;
  }

  /** A missing member is created void and the operation applied to it. */
  override operation(
    flag: number,
    member: string | null,
    result: VariantSlot | null,
    param: Variant | null,
    objthis: Dispatch | null,
  ): number {
    let hr = super.operation(flag, member, result, param, objthis);
    if (hr === TJS_E_MEMBERNOTFOUND && !(flag & TJS_MEMBERMUSTEXIST)) {
      hr = super.propSet(TJS_MEMBERENSURE, member, VOID, objthis);
      if (hr < 0) return hr;
      hr = super.operation(flag, member, result, param, objthis);
    }
    return hr;
  }
}

/** The hash bits `RebuildHash` chooses for a member count. */
export function hashBitsFor(count: number): number {
  let r: number,
    v = count;
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
  return r + ((0xffffaa50 >>> v) & 0x03) + 2;
}

export class DictionaryClass extends NativeClass {
  constructor(private readonly engine: TjsEngine) {
    super('Dictionary', () => new DictionaryNI());
    const self = this;
    const ni = (objthis: Dispatch) => instanceOf<DictionaryNI>(objthis, DICTIONARY_CLASS_ID);

    this.constructorMethod((_result, args, objthis) => {
      const r = constructNativeInstance(self, args, objthis);
      return typeof r === 'number' ? r : TJS_S_OK;
    }, TJS_STATICMEMBER);

    this.staticMethod('load', (_result, _args, objthis) => {
      const d = ni(objthis);
      if (!d) return TJS_E_NATIVECLASSCRASH;
      if (!d.valid) return TJS_E_INVALIDOBJECT;
      return TJS_S_OK; // not implemented natively either
    });

    this.staticMethod('loadStruct', () => TJS_E_NOTIMPL); // binary/text loader: not ported yet

    this.staticMethod('save', (_result, _args, objthis) => {
      const d = ni(objthis);
      if (!d) return TJS_E_NATIVECLASSCRASH;
      if (!d.valid) return TJS_E_INVALIDOBJECT;
      return TJS_S_OK; // not implemented natively either
    });

    this.staticMethod('saveStruct', (result, args, objthis) => {
      const d = ni(objthis);
      if (!d) return TJS_E_NATIVECLASSCRASH;
      if (!d.valid) return TJS_E_INVALIDOBJECT;
      if (args.length < 1) return TJS_E_BADPARAMCOUNT;
      const mode = args.length >= 2 && args[1]!.type !== 0 ? asString(args[1]!) : '';
      if (mode.includes('b')) return TJS_E_NOTIMPL; // binary serializer: not ported yet
      const out = engine.host.openTextWrite(asString(args[0]!), mode);
      try {
        d.saveStructuredData([objthis], out, '');
      } finally {
        out.close();
      }
      result?.set(obj(objthis, objthis));
      return TJS_S_OK;
    });

    this.staticMethod('assign', (_result, args, objthis) => {
      const d = ni(objthis);
      if (!d) return TJS_E_NATIVECLASSCRASH;
      if (!d.valid) return TJS_E_INVALIDOBJECT;
      if (args.length < 1) return TJS_E_BADPARAMCOUNT;
      const clear = args.length >= 2 && args[1]!.type !== 0 ? asInt32(args[1]!) !== 0 : true;
      const clo = asObjectClosure(args[0]!);
      const src = clo.objthis ?? clo.object ?? throwTjsError('TJSNullAccess');
      self.assign(d.owner!, src, clear);
      return TJS_S_OK;
    });

    this.staticMethod('assignStruct', (_result, args, objthis) => {
      const d = ni(objthis);
      if (!d) return TJS_E_NATIVECLASSCRASH;
      if (!d.valid) return TJS_E_INVALIDOBJECT;
      if (args.length < 1) return TJS_E_BADPARAMCOUNT;
      const clo = asObjectClosure(args[0]!);
      const src = clo.objthis ?? clo.object ?? throwTjsError('TJSNullAccess');
      self.assignStructure(d.owner!, src, []);
      return TJS_S_OK;
    });

    this.staticMethod('clear', (_result, _args, objthis) => {
      const d = ni(objthis);
      if (!d) return TJS_E_NATIVECLASSCRASH;
      if (!d.valid) return TJS_E_INVALIDOBJECT;
      d.owner!.clear();
      return TJS_S_OK;
    });
  }

  protected override createBaseObject(): CustomObject {
    return new DictionaryObject();
  }

  /** `new Dictionary(n)` with an Integer n ≥ 8 sizes the member table for n members. */
  override createNew(
    flag: number,
    member: string | null,
    result: Out<Dispatch | null>,
    args: readonly Variant[],
    objthis: Dispatch | null,
  ): number {
    if (args.length < 1 || args[0]!.type !== 4 || asInt32(args[0]!) < 8)
      return super.createNew(flag, member, result, args, objthis);
    const dsp = new DictionaryObject(hashBitsFor(asInt32(args[0]!)));
    let hr: number;
    try {
      hr = this.funcCall(0, null, null, [], dsp);
      if (hr < 0) return hr;
      hr = this.funcCall(0, this.className, null, args, dsp);
      if (hr === TJS_E_MEMBERNOTFOUND) hr = TJS_S_OK;
    } catch (e) {
      dsp.release();
      throw e;
    }
    if (hr >= 0) result.value = dsp;
    return hr;
  }

  /** `tTJSDictionaryNI::Assign`: pairs of an array, or the visible members of an object. */
  assign(owner: CustomObject, src: Dispatch, clear: boolean): void {
    const arr = instanceOf<ArrayNI>(src, ARRAY_CLASS_ID);
    if (arr) {
      if (clear) owner.clear();
      owner.rebuildHash(owner.count + arr.items.length);
      const items = [...arr.items];
      for (let i = 0; i + 1 < items.length; i += 2)
        owner.propSet(TJS_MEMBERENSURE | TJS_IGNOREPROP, asString(items[i]!), items[i + 1]!, owner);
      return;
    }
    if (clear) owner.clear();
    let count = 0;
    forEachMember(src, (_name, flags) => {
      if (!(flags & TJS_HIDDENMEMBER)) count++;
    });
    owner.rebuildHash(count + owner.count);
    forEachMember(src, (name, flags, value) => {
      if (flags & TJS_HIDDENMEMBER) return;
      owner.propSet(TJS_MEMBERENSURE | TJS_IGNOREPROP | flags, name, value, owner);
    });
  }

  /** `tTJSDictionaryNI::AssignStructure`: deep copy of a dictionary. */
  assignStructure(owner: CustomObject, src: Dispatch, stack: Dispatch[]): void {
    if (!instanceOf(src, DICTIONARY_CLASS_ID)) throwTjsError('TJSSpecifyDicOrArray');
    stack.push(src);
    try {
      owner.clear();
      let count = 0;
      forEachMember(src, (_name, flags) => {
        if (!(flags & TJS_HIDDENMEMBER)) count++;
      });
      owner.rebuildHash(count + owner.count);
      forEachMember(src, (name, flags, value) => {
        if (flags & TJS_HIDDENMEMBER) return;
        const copy = this.engine.newStructuredCopy(value, stack);
        if (!copy) {
          owner.propSet(TJS_MEMBERENSURE | TJS_IGNOREPROP, name, value, owner);
          return;
        }
        // Natively the copy is filled before it is stored.
        copy.fill();
        owner.propSet(TJS_MEMBERENSURE | TJS_IGNOREPROP, name, copy.value, owner);
        copy.object?.release();
      });
    } finally {
      stack.pop();
    }
  }
}

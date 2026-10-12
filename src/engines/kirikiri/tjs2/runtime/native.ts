/**
 * Native classes, methods and properties (krkrz `tjsNative.cpp`, the `TJS_BEGIN_NATIVE_*`
 * macros). A `NativeClass` is a custom object holding method and property objects; `new`
 * creates a custom object, copies the class's non-static members into it with their context
 * set to the new object, registers the native instance and calls the constructor member named
 * after the class.
 */
import {CustomObject} from './custom-object.js';
import {DispatchBase} from './dispatch.js';
import {
  failed,
  TJS_E_ACCESSDENYED,
  TJS_E_FAIL,
  TJS_E_MEMBERNOTFOUND,
  TJS_E_NATIVECLASSCRASH,
  TJS_IGNOREPROP,
  TJS_MEMBERENSURE,
  TJS_NIS_GETINSTANCE,
  TJS_NIS_REGISTER,
  TJS_S_OK,
  TJS_S_TRUE,
  TJS_STATICMEMBER,
  TJS_CII_ADD,
  type Dispatch,
  type NativeInstance,
  type Out,
} from './interface.js';
import {VariantSlot} from './slot.js';
import {asInt32, asString, int, obj, str, type Variant} from './variant.js';

// --- Native class IDs (TJSRegisterNativeClass) ----------------------------------------------

const nativeClassNames: string[] = [];

/** `TJSRegisterNativeClass`: the ID of a class name, assigned on first registration. */
export function registerNativeClass(name: string): number {
  const i = nativeClassNames.indexOf(name);
  if (i >= 0) return i;
  nativeClassNames.push(name);
  return nativeClassNames.length - 1;
}
export function findNativeClassId(name: string): number {
  return nativeClassNames.indexOf(name);
}
export function findNativeClassName(id: number): string | null {
  return nativeClassNames[id] ?? null;
}

/** `TJS_GET_NATIVE_INSTANCE`: the object's native instance of a class, or null. */
export function getNativeInstance<T extends NativeInstance>(
  objthis: Dispatch | null,
  classId: number,
): T | null {
  if (!objthis) return null;
  const p: Out<NativeInstance | null> = {value: null};
  if (failed(objthis.nativeInstanceSupport(TJS_NIS_GETINSTANCE, classId, p))) return null;
  return p.value as T | null;
}

/** `tTJSNativeInstance`: an instance with no state. */
export class NativeInstanceBase implements NativeInstance {
  construct(_args: readonly Variant[], _owner: Dispatch): number {
    return TJS_S_OK;
  }
  invalidate(): void {}
  destruct(): void {}
}

/** `TJS_PARAM_EXIST`: the argument is given and not void. */
export function paramExists(args: readonly Variant[], n: number): boolean {
  return n < args.length && args[n]!.type !== 0;
}

// --- Members -----------------------------------------------------------------------------------

/** A native method body: `(result, args, objthis)` → result code. `result` is cleared first. */
export type NativeMethodCallback = (
  result: VariantSlot | null,
  args: readonly Variant[],
  objthis: Dispatch,
) => number;
export type NativeConstructorCallback = (
  result: VariantSlot | null,
  args: readonly Variant[],
  objthis: Dispatch | null,
) => number;
export type NativePropertyGetter = (result: VariantSlot, objthis: Dispatch) => number;
export type NativePropertySetter = (value: Variant, objthis: Dispatch) => number;

/** `tTJSNativeClassMethod`: a Function object calling a native callback. */
export class NativeClassMethod extends DispatchBase {
  constructor(protected readonly process: NativeMethodCallback) {
    super();
  }
  override isInstanceOf(
    flag: number,
    member: string | null,
    className: string,
    objthis: Dispatch | null,
  ): number {
    if (member === null && className === 'Function') return TJS_S_TRUE;
    return super.isInstanceOf(flag, member, className, objthis);
  }
  override funcCall(
    flag: number,
    member: string | null,
    result: VariantSlot | null,
    args: readonly Variant[],
    objthis: Dispatch | null,
  ): number {
    if (member !== null) return super.funcCall(flag, member, result, args, objthis);
    if (!objthis) return TJS_E_NATIVECLASSCRASH;
    result?.clear();
    return this.process(result, args, objthis);
  }
}

/** `tTJSNativeClassConstructor`: like a method, but callable without a context. */
export class NativeClassConstructor extends NativeClassMethod {
  constructor(process: NativeConstructorCallback) {
    super(process as NativeMethodCallback);
  }
  override funcCall(
    flag: number,
    member: string | null,
    result: VariantSlot | null,
    args: readonly Variant[],
    objthis: Dispatch | null,
  ): number {
    if (member !== null)
      return DispatchBase.prototype.funcCall.call(this, flag, member, result, args, objthis);
    result?.clear();
    return (this.process as NativeConstructorCallback)(result, args, objthis);
  }
}

const denyGet: NativePropertyGetter = () => TJS_E_ACCESSDENYED;
const denySet: NativePropertySetter = () => TJS_E_ACCESSDENYED;

/** `tTJSNativeClassProperty`: a Property object; a missing accessor denies access. */
export class NativeClassProperty extends DispatchBase {
  constructor(
    readonly get: NativePropertyGetter = denyGet,
    readonly set: NativePropertySetter = denySet,
  ) {
    super();
  }
  override isInstanceOf(
    flag: number,
    member: string | null,
    className: string,
    objthis: Dispatch | null,
  ): number {
    if (member === null && className === 'Property') return TJS_S_TRUE;
    return super.isInstanceOf(flag, member, className, objthis);
  }
  override propGet(
    flag: number,
    member: string | null,
    result: VariantSlot | null,
    objthis: Dispatch | null,
  ): number {
    if (member !== null) return super.propGet(flag, member, result, objthis);
    if (!objthis) return TJS_E_NATIVECLASSCRASH;
    if (!result) return TJS_E_FAIL;
    return this.get(result, objthis);
  }
  override propSet(
    flag: number,
    member: string | null,
    value: Variant,
    objthis: Dispatch | null,
  ): number {
    if (member !== null) return super.propSet(flag, member, value, objthis);
    if (!objthis) return TJS_E_NATIVECLASSCRASH;
    return this.set(value, objthis);
  }
}

/** `tTJSNativeFunction`: a standalone Function object (global functions, plugin exports). */
export class NativeFunction extends DispatchBase {
  constructor(
    private readonly process: (
      result: VariantSlot | null,
      args: readonly Variant[],
      objthis: Dispatch | null,
    ) => number,
  ) {
    super();
  }
  override funcCall(
    flag: number,
    member: string | null,
    result: VariantSlot | null,
    args: readonly Variant[],
    objthis: Dispatch | null,
  ): number {
    if (member !== null) return super.funcCall(flag, member, result, args, objthis);
    return this.process(result, args, objthis);
  }
  override isInstanceOf(
    flag: number,
    member: string | null,
    className: string,
    objthis: Dispatch | null,
  ): number {
    if (member === null && className === 'Function') return TJS_S_TRUE;
    return super.isInstanceOf(flag, member, className, objthis);
  }
}

// --- Classes -----------------------------------------------------------------------------------

/** Copies a class's members into a new instance (the `tCallback` of `tTJSNativeClass`). */
class MemberCopier extends DispatchBase {
  constructor(private readonly dest: Dispatch) {
    super();
  }
  override funcCall(
    _flag: number,
    member: string | null,
    result: VariantSlot | null,
    args: readonly Variant[],
    _objthis: Dispatch | null,
  ): number {
    if (member !== null) return TJS_E_MEMBERNOTFOUND;
    const flags = asInt32(args[1]!);
    if (!(flags & TJS_STATICMEMBER)) {
      let v = args[2]!;
      if (v.type === 1 && v.objthis === null) v = obj(v.object, this.dest);
      this.dest.propSet(
        TJS_MEMBERENSURE | TJS_IGNOREPROP | flags,
        asString(args[0]!),
        v,
        this.dest,
      );
    }
    result?.set(int(1));
    return TJS_S_OK;
  }
}

/** `tTJSNativeClass`. Subclass it or pass a native instance factory. */
export class NativeClass extends CustomObject {
  readonly classId: number;

  constructor(
    readonly className: string,
    private readonly nativeInstanceFactory: (() => NativeInstance | null) | null = null,
  ) {
    super();
    this.callFinalize = false;
    this.classId = registerNativeClass(className);
  }

  /** `CreateNativeInstance`: null for classes without native state. */
  protected createNativeInstance(): NativeInstance | null {
    return this.nativeInstanceFactory ? this.nativeInstanceFactory() : null;
  }

  /** `CreateBaseTJSObject`: the object `new` fills. */
  protected createBaseObject(): CustomObject {
    return new CustomObject();
  }

  /** `RegisterNCM`: adds a member object; the class takes over the caller's reference. */
  registerMember(name: string, dsp: Dispatch, flags = 0): void {
    this.propSet(TJS_MEMBERENSURE | TJS_IGNOREPROP | flags, name, obj(dsp), this);
    dsp.release();
  }

  method(name: string, process: NativeMethodCallback, flags = 0): this {
    this.registerMember(name, new NativeClassMethod(process), flags);
    return this;
  }

  staticMethod(name: string, process: NativeMethodCallback): this {
    return this.method(name, process, TJS_STATICMEMBER);
  }

  /** The constructor member, named after the class. */
  constructorMethod(process: NativeConstructorCallback, flags = 0): this {
    this.registerMember(this.className, new NativeClassConstructor(process), flags);
    return this;
  }

  property(
    name: string,
    accessors: {get?: NativePropertyGetter; set?: NativePropertySetter},
    flags = 0,
  ): this {
    this.registerMember(name, new NativeClassProperty(accessors.get, accessors.set), flags);
    return this;
  }

  staticProperty(
    name: string,
    accessors: {get?: NativePropertyGetter; set?: NativePropertySetter},
  ): this {
    return this.property(name, accessors, TJS_STATICMEMBER);
  }

  /** `TJS_DECL_EMPTY_FINALIZE_METHOD`. */
  emptyFinalize(): this {
    return this.method('finalize', () => TJS_S_OK);
  }

  /** The native instance of this class on an object (`TJS_GET_NATIVE_INSTANCE`). */
  instanceOf<T extends NativeInstance>(objthis: Dispatch | null): T | null {
    return getNativeInstance<T>(objthis, this.classId);
  }

  /**
   * With a member name, a member of the class. Without one, the class initializes `objthis`
   * as its instance: adds the class name, registers the native instance, copies the members.
   */
  override funcCall(
    flag: number,
    member: string | null,
    result: VariantSlot | null,
    args: readonly Variant[],
    objthis: Dispatch | null,
  ): number {
    if (!this.validity) return super.funcCall(flag, member, result, args, objthis);
    if (member !== null) return super.funcCall(flag, member, result, args, objthis);
    const target = objthis!;
    const name = new VariantSlot(str(this.className));
    target.classInstanceInfo(TJS_CII_ADD, 0, name);
    name.clear();
    const instance: Out<NativeInstance | null> = {value: this.createNativeInstance()};
    target.nativeInstanceSupport(TJS_NIS_REGISTER, this.classId, instance);
    const copier = new MemberCopier(target);
    try {
      this.enumMembers(TJS_IGNOREPROP, obj(copier), this);
    } finally {
      copier.release();
    }
    return TJS_S_OK;
  }

  override createNew(
    flag: number,
    member: string | null,
    result: Out<Dispatch | null>,
    args: readonly Variant[],
    objthis: Dispatch | null,
  ): number {
    if (member !== null) return super.createNew(flag, member, result, args, objthis);
    const dsp = this.createBaseObject();
    let hr: number;
    try {
      hr = this.funcCall(0, null, null, [], dsp);
      if (failed(hr)) return hr;
      hr = this.funcCall(0, this.className, null, args, dsp);
      if (hr === TJS_E_MEMBERNOTFOUND) hr = TJS_S_OK;
    } catch (e) {
      dsp.release();
      throw e;
    }
    if (!failed(hr)) result.value = dsp;
    return hr;
  }

  override isInstanceOf(
    flag: number,
    member: string | null,
    className: string,
    objthis: Dispatch | null,
  ): number {
    if (member === null) {
      if (className === 'Class') return TJS_S_TRUE;
      if (className === this.className) return TJS_S_TRUE;
    }
    return super.isInstanceOf(flag, member, className, objthis);
  }
}

/**
 * The constructor body of `TJS_BEGIN_NATIVE_CONSTRUCTOR_DECL`: finds the instance registered
 * by `new` and calls its `construct`.
 */
export function constructNativeInstance<T extends NativeInstance>(
  cls: NativeClass,
  args: readonly Variant[],
  objthis: Dispatch | null,
): T | number {
  if (!objthis) return TJS_E_NATIVECLASSCRASH;
  const p: Out<NativeInstance | null> = {value: null};
  if (failed(objthis.nativeInstanceSupport(TJS_NIS_GETINSTANCE, cls.classId, p)))
    return TJS_E_NATIVECLASSCRASH;
  if (!p.value) return TJS_E_NATIVECLASSCRASH;
  const hr = p.value.construct(args, objthis);
  if (failed(hr)) return hr;
  return p.value as T;
}

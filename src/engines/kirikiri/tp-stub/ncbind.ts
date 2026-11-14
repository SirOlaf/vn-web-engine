/**
 * ncbind, the class binding layer most TVP plugins are built with (`ncbind.hpp`), on the
 * function exporter. A plugin implementation describes its classes with `NcbRegistrar`; the
 * registration follows ncbind:
 *
 * - `registerClass`: `TJSCreateNativeClassForPlugin` with an empty instance adaptor,
 *   `TJSRegisterNativeClass` + `TJSNativeClassSetClassID`, an empty `finalize`, the members in
 *   order, a constructor returning `TJS_E_NOTIMPL` when none was given, then the class object
 *   as a global.
 * - `subClass`: the same without the global; the class object becomes a static member of the
 *   outer class.
 * - `attachClass`: members added to an existing TJS class (`NCB_ATTACH_CLASS`); its instances
 *   get the native part on first use when the attachment has an instance hook.
 *
 * Methods count their arguments first (`TJS_E_BADPARAMCOUNT`), then find the native instance
 * (`TJS_E_NATIVECLASSCRASH` without one). A constructor called with a single void argument
 * creates no native instance (the path of `CreateAdaptor`). Member objects are plugin objects:
 * they count towards `TvpPluginObjects`, which `V2Unlink` compares with the count after
 * `V2Link` (`TVPPluginGlobalRefCount`).
 */
import {
  failed,
  NIT_METHOD,
  NIT_PROPERTY,
  TJS_E_ACCESSDENYED,
  TJS_E_BADPARAMCOUNT,
  TJS_E_NATIVECLASSCRASH,
  TJS_E_NOTIMPL,
  TJS_IGNOREPROP,
  TJS_MEMBERENSURE,
  TJS_MEMBERMUSTEXIST,
  TJS_NIS_GETINSTANCE,
  TJS_NIS_REGISTER,
  TJS_S_OK,
  TJS_STATICMEMBER,
  type Dispatch,
  type NativeClassObject,
  type NativeInstance,
  type Out,
  type TvpFunctionExporter,
  type TvpPluginExports,
  type Variant,
  type VariantResult,
} from '../tjs2/runtime/interface.js';
import {NativeClassMethod, NativeClassProperty} from '../tjs2/runtime/native.js';
import {VariantSlot} from '../tjs2/runtime/slot.js';
import {asBoolean, asInteger, asReal, asString, obj, VOID} from '../tjs2/runtime/variant.js';

/** `E_FAIL`, the HRESULT `V2Unlink` returns while plugin objects are still alive. */
export const E_FAIL = 0x80004005 | 0;

// --- Argument conversions (ncbTypeConvertor) -----------------------------------------------

/** `(tjs_int)var`: the integer value truncated to 32 bits. */
export function ncbInt(v: Variant): number {
  return Number(BigInt.asIntN(32, asInteger(v)));
}
/** `(tjs_uint)var`. */
export function ncbUint(v: Variant): number {
  return Number(BigInt.asUintN(32, asInteger(v)));
}
/** `(tjs_int64)var`. */
export function ncbInt64(v: Variant): bigint {
  return asInteger(v);
}
export function ncbReal(v: Variant): number {
  return asReal(v);
}
export function ncbBool(v: Variant): boolean {
  return asBoolean(v);
}
/** `ttstr(var)`; void converts to the empty string. */
export function ncbString(v: Variant): string {
  return v.type === 0 ? '' : asString(v);
}

// --- Plugin objects ------------------------------------------------------------------------

/** `TVPPluginGlobalRefCount`: the plugin's live TJS objects. */
export class TvpPluginObjects {
  count = 0;
}

/** A plugin-side `tTJSDispatch` method object. */
class NcbMethodObject extends NativeClassMethod {
  constructor(
    private readonly objects: TvpPluginObjects,
    process: (result: VariantSlot | null, args: readonly Variant[], objthis: Dispatch) => number,
  ) {
    super(process);
    objects.count++;
  }
  protected override destruct(): void {
    this.objects.count--;
    super.destruct();
  }
}

/** `ncbNativeClassConstructor`: callable without a context; a void argument creates nothing. */
class NcbConstructorObject extends NativeClassMethod {
  constructor(
    private readonly objects: TvpPluginObjects,
    private readonly construct: (
      result: VariantSlot | null,
      args: readonly Variant[],
      objthis: Dispatch | null,
    ) => number,
  ) {
    super(() => TJS_E_NATIVECLASSCRASH);
    objects.count++;
  }
  override funcCall(
    flag: number,
    member: string | null,
    result: VariantSlot | null,
    args: readonly Variant[],
    objthis: Dispatch | null,
  ): number {
    if (member !== null) return super.funcCall(flag, member, result, args, objthis);
    if (args.length === 1 && args[0]!.type === 0) return TJS_S_OK;
    result?.clear();
    return this.construct(result, args, objthis);
  }
  protected override destruct(): void {
    this.objects.count--;
    super.destruct();
  }
}

class NcbPropertyObject extends NativeClassProperty {
  constructor(
    private readonly objects: TvpPluginObjects,
    get?: (result: VariantSlot, objthis: Dispatch) => number,
    set?: (value: Variant, objthis: Dispatch) => number,
  ) {
    super(get, set);
    objects.count++;
  }
  protected override destruct(): void {
    this.objects.count--;
    super.destruct();
  }
}

// --- Instances -------------------------------------------------------------------------------

/** A native class instance may release resources when its object is invalidated. */
export interface NcbDisposable {
  dispose?(): void;
}

/** `ncbInstanceAdaptor<T>`: the native instance registered on a TJS object. */
export class NcbAdaptor<T extends object> implements NativeInstance {
  instance: T | null = null;
  /** Not owned: invalidation does not dispose it. */
  sticky = false;
  construct(): number {
    return TJS_S_OK;
  }
  invalidate(): void {
    this.#delete();
  }
  destruct(): void {
    this.#delete();
  }
  #delete(): void {
    const inst = this.instance;
    if (inst && !this.sticky) (inst as NcbDisposable).dispose?.();
    this.instance = null;
    this.sticky = false;
  }
}

/** `ncbClassInfo<T>`: a class's name, ID and class object while it is registered. */
export class NcbClassInfo<T extends object> {
  id = -1;
  classObject: NativeClassObject | null = null;
  constructor(readonly name: string) {}

  /** `GetAdaptor`. */
  adaptor(objthis: Dispatch | null): NcbAdaptor<T> | null {
    if (!objthis || this.id < 0) return null;
    const p: Out<NativeInstance | null> = {value: null};
    if (failed(objthis.nativeInstanceSupport(TJS_NIS_GETINSTANCE, this.id, p))) return null;
    return p.value as NcbAdaptor<T> | null;
  }

  /** `GetNativeInstance`: the native instance, or null. */
  instance(objthis: Dispatch | null): T | null {
    return this.adaptor(objthis)?.instance ?? null;
  }

  /** `SetNativeInstance` on the adaptor `new` registered. */
  setInstance(objthis: Dispatch | null, instance: T): boolean {
    const adp = this.adaptor(objthis);
    if (!adp) return false;
    adp.instance = instance;
    return true;
  }

  /** `SetAdaptorWithNativeInstance`: registers an adaptor first when the object has none. */
  attachInstance(objthis: Dispatch, instance: T): boolean {
    let adp = this.adaptor(objthis);
    if (adp) {
      adp.invalidate();
    } else {
      adp = new NcbAdaptor<T>();
      const p: Out<NativeInstance | null> = {value: adp};
      if (failed(objthis.nativeInstanceSupport(TJS_NIS_REGISTER, this.id, p))) return false;
    }
    adp.instance = instance;
    return true;
  }

  /**
   * `CreateAdaptor`: a new TJS object of the class holding `instance` (`new` with one void
   * argument, so the constructor creates nothing). Owned by the caller.
   */
  createObject(exporter: TvpFunctionExporter, instance: T, sticky = false): Dispatch {
    const cls = this.classObject;
    if (!cls) exporter.TVPThrowExceptionMessage('No class object.');
    const global = exporter.TVPGetScriptDispatch();
    const out: Out<Dispatch | null> = {value: null};
    let hr: number;
    try {
      hr = cls.createNew(0, null, out, [VOID], global);
    } finally {
      global.release();
    }
    if (failed(hr) || !out.value) exporter.TVPThrowExceptionMessage("Can't create instance");
    const adp = this.adaptor(out.value);
    if (adp) {
      adp.instance = instance;
      adp.sticky = sticky;
    }
    return out.value;
  }
}

// --- Registration ----------------------------------------------------------------------------

/**
 * A method body: returns the result value (void leaves the result as it is). A body that
 * creates an object stores it in `result` itself and releases its own reference.
 */
export type NcbMethod<T> = (
  self: T,
  args: readonly Variant[],
  objthis: Dispatch,
  result: VariantResult | null,
) => Variant | void;
export type NcbStaticMethod = (
  args: readonly Variant[],
  objthis: Dispatch,
  result: VariantResult | null,
) => Variant | void;
/** A raw callback (`RawCallback` with `iTJSDispatch2 *objthis`). */
export type NcbRawCallback = (
  result: VariantResult | null,
  args: readonly Variant[],
  objthis: Dispatch,
) => number;
/** A raw callback with the native instance (`RawCallback` with `ClassT *self`). */
export type NcbRawInstanceCallback<T> = (
  result: VariantResult | null,
  args: readonly Variant[],
  self: T,
  objthis: Dispatch,
) => number;

interface RegistrationTarget {
  item(name: string, dsp: Dispatch, type: number, flags: number): void;
  variant(name: string, value: Variant, flags: number): void;
}

/** Shared state of one plugin's registrations. */
export interface NcbContext {
  readonly exporter: TvpFunctionExporter;
  readonly objects: TvpPluginObjects;
}

/** The members of one class, in the order a `NCB_REGISTER_CLASS` body lists them. */
export class NcbRegistrar<T extends object> {
  #hasConstructor = false;

  constructor(
    readonly ctx: NcbContext,
    readonly info: NcbClassInfo<T>,
    private readonly target: RegistrationTarget,
    /** How methods find the native instance (`NCB_GET_INSTANCE_HOOK`). */
    private readonly getInstance: (objthis: Dispatch) => T | null = (o) => info.instance(o),
  ) {}

  get hasConstructor(): boolean {
    return this.#hasConstructor;
  }

  /** `Constructor<…>()` / `Factory`: `create` returns the native instance. */
  constructor_(minArgs: number, create: (args: readonly Variant[], objthis: Dispatch) => T): this {
    const {ctx, info} = this;
    this.#markConstructor();
    const dsp = new NcbConstructorObject(ctx.objects, (_result, args, objthis) => {
      if (args.length < minArgs) return TJS_E_BADPARAMCOUNT;
      if (!objthis) return TJS_E_NATIVECLASSCRASH;
      const inst = create(args, objthis);
      if (!inst) ctx.exporter.TVPThrowExceptionMessage('NativeClassInstance creation faild.');
      if (!info.setInstance(objthis, inst)) {
        (inst as NcbDisposable).dispose?.();
        return TJS_E_NATIVECLASSCRASH;
      }
      return TJS_S_OK;
    });
    this.target.item(info.name, dsp, NIT_METHOD, 0);
    return this;
  }

  /** A raw constructor (`RawCallback` under the class name). */
  rawConstructor(body: NcbRawCallback): this {
    this.#markConstructor();
    this.target.item(
      this.info.name,
      new NcbMethodObject(this.ctx.objects, (r, a, o) => body(r, a, o)),
      NIT_METHOD,
      0,
    );
    return this;
  }

  #markConstructor(): void {
    if (this.#hasConstructor)
      this.ctx.exporter.TVPAddLog(`Multiple constructors.(${this.info.name})`);
    this.#hasConstructor = true;
  }

  method(name: string, minArgs: number, body: NcbMethod<T>): this {
    const dsp = new NcbMethodObject(this.ctx.objects, (result, args, objthis) => {
      if (args.length < minArgs) return TJS_E_BADPARAMCOUNT;
      const self = this.getInstance(objthis);
      if (!self) return TJS_E_NATIVECLASSCRASH;
      const v = body(self, args, objthis, result);
      if (v && result) result.set(v);
      return TJS_S_OK;
    });
    this.target.item(name, dsp, NIT_METHOD, 0);
    return this;
  }

  staticMethod(name: string, minArgs: number, body: NcbStaticMethod): this {
    const dsp = new NcbMethodObject(this.ctx.objects, (result, args, objthis) => {
      if (args.length < minArgs) return TJS_E_BADPARAMCOUNT;
      const v = body(args, objthis, result);
      if (v && result) result.set(v);
      return TJS_S_OK;
    });
    this.target.item(name, dsp, NIT_METHOD, TJS_STATICMEMBER);
    return this;
  }

  rawCallback(name: string, body: NcbRawCallback, flags = 0): this {
    this.target.item(
      name,
      new NcbMethodObject(this.ctx.objects, (r, a, o) => body(r, a, o)),
      NIT_METHOD,
      flags,
    );
    return this;
  }

  rawInstanceCallback(name: string, body: NcbRawInstanceCallback<T>, flags = 0): this {
    const dsp = new NcbMethodObject(this.ctx.objects, (result, args, objthis) => {
      const self = this.getInstance(objthis);
      if (!self) return TJS_E_NATIVECLASSCRASH;
      return body(result, args, self, objthis);
    });
    this.target.item(name, dsp, NIT_METHOD, flags);
    return this;
  }

  /** A property; a null accessor denies access (`(int)0`). */
  property(
    name: string,
    get: ((self: T, objthis: Dispatch) => Variant) | null,
    set: ((self: T, value: Variant, objthis: Dispatch) => void) | null,
  ): this {
    const dsp = new NcbPropertyObject(
      this.ctx.objects,
      get
        ? (result, objthis) => {
            const self = this.getInstance(objthis);
            if (!self) return TJS_E_NATIVECLASSCRASH;
            result.set(get(self, objthis));
            return TJS_S_OK;
          }
        : () => TJS_E_ACCESSDENYED,
      set
        ? (value, objthis) => {
            const self = this.getInstance(objthis);
            if (!self) return TJS_E_NATIVECLASSCRASH;
            set(self, value, objthis);
            return TJS_S_OK;
          }
        : () => TJS_E_ACCESSDENYED,
    );
    this.target.item(name, dsp, NIT_PROPERTY, 0);
    return this;
  }

  staticProperty(
    name: string,
    get: ((objthis: Dispatch) => Variant) | null,
    set: ((value: Variant, objthis: Dispatch) => void) | null,
  ): this {
    const dsp = new NcbPropertyObject(
      this.ctx.objects,
      get
        ? (result, objthis) => {
            result.set(get(objthis));
            return TJS_S_OK;
          }
        : () => TJS_E_ACCESSDENYED,
      set
        ? (value, objthis) => {
            set(value, objthis);
            return TJS_S_OK;
          }
        : () => TJS_E_ACCESSDENYED,
    );
    this.target.item(name, dsp, NIT_PROPERTY, TJS_STATICMEMBER);
    return this;
  }

  /** A raw property (`RawCallback` with getter and setter callbacks). */
  rawProperty(
    name: string,
    get: ((result: VariantResult, objthis: Dispatch) => number) | null,
    set: ((value: Variant, objthis: Dispatch) => number) | null,
    flags = 0,
  ): this {
    const dsp = new NcbPropertyObject(
      this.ctx.objects,
      get ?? (() => TJS_E_ACCESSDENYED),
      set ?? (() => TJS_E_ACCESSDENYED),
    );
    this.target.item(name, dsp, NIT_PROPERTY, flags);
    return this;
  }

  /** `Variant(name, value, flags)`: a value member (static unless flags say otherwise). */
  variant(name: string, value: Variant, flags = TJS_STATICMEMBER): this {
    this.target.variant(name, value, flags);
    return this;
  }

  /** `NCB_SUBCLASS`: registers `definition` and adds its class object as a static member. */
  subClass<U extends object>(name: string, definition: NcbClassDefinition<U>): this {
    const info = definition.info;
    if (info.classObject)
      this.ctx.exporter.TVPThrowExceptionMessage('SubClass registration failed.');
    const cls = beginClass(this.ctx, info, name);
    const r = new NcbRegistrar<U>(this.ctx, info, classTarget(this.ctx, cls));
    definition.define(r);
    endClassMembers(this.ctx, r, cls);
    // ncbSubClassItem: the class object is the item (nitClass, static); RegisterNCM takes
    // over the creation reference, ncbClassInfo keeps the pointer.
    this.target.item(name, cls, 0, TJS_STATICMEMBER);
    return this;
  }
}

/** A class description: its info record and the `NCB_REGISTER_CLASS` body. */
export interface NcbClassDefinition<T extends object> {
  readonly info: NcbClassInfo<T>;
  define(r: NcbRegistrar<T>): void;
}

function classTarget(ctx: NcbContext, cls: NativeClassObject): RegistrationTarget {
  return {
    item: (name, dsp, type, flags) =>
      ctx.exporter.TJSNativeClassRegisterNCM(cls, name, dsp, cls.className, type, flags),
    variant: (name, value, flags) => {
      cls.propSet(TJS_MEMBERENSURE | flags, name, value, cls);
    },
  };
}

/** `RegistBegin`. */
function beginClass<T extends object>(
  ctx: NcbContext,
  info: NcbClassInfo<T>,
  name = info.name,
): NativeClassObject {
  const ex = ctx.exporter;
  const cls = ex.TJSCreateNativeClassForPlugin(name, () => new NcbAdaptor<T>());
  const id = ex.TJSRegisterNativeClass(name);
  if (info.classObject) ex.TVPThrowExceptionMessage('Already registerd class.');
  info.id = id;
  info.classObject = cls;
  ex.TJSNativeClassSetClassID(cls, id);
  ex.TJSNativeClassRegisterNCM(
    cls,
    'finalize',
    ex.TJSCreateNativeClassMethod(() => TJS_S_OK),
    name,
    NIT_METHOD,
    0,
  );
  return cls;
}

/** `_AddDummyConstructor`. */
function endClassMembers<T extends object>(
  ctx: NcbContext,
  r: NcbRegistrar<T>,
  cls: NativeClassObject,
): void {
  if (!r.hasConstructor)
    ctx.exporter.TJSNativeClassRegisterNCM(
      cls,
      cls.className,
      ctx.exporter.TJSCreateNativeClassMethod(() => TJS_E_NOTIMPL),
      cls.className,
      NIT_METHOD,
      0,
    );
}

/** `NCB_REGISTER_CLASS`: registers the class and sets it as a global. */
export function registerClass<T extends object>(
  ctx: NcbContext,
  definition: NcbClassDefinition<T>,
): void {
  const info = definition.info;
  const cls = beginClass(ctx, info);
  const r = new NcbRegistrar<T>(ctx, info, classTarget(ctx, cls));
  definition.define(r);
  endClassMembers(ctx, r, cls);
  const global = ctx.exporter.TVPGetScriptDispatch();
  try {
    // The variant holds the class; ncbClassInfo keeps the pointer without a reference.
    global.propSet(TJS_MEMBERENSURE, info.name, obj(cls), global);
  } finally {
    cls.release();
    global.release();
  }
}

/** Unregistration of `registerClass`: deletes the global. */
export function unregisterClass<T extends object>(
  ctx: NcbContext,
  definition: NcbClassDefinition<T>,
): void {
  const global = ctx.exporter.TVPGetScriptDispatch();
  try {
    global.deleteMember(0, definition.info.name, global);
  } finally {
    global.release();
  }
  clearClassInfo(definition.info);
}

function clearClassInfo<T extends object>(info: NcbClassInfo<T>): void {
  info.classObject = null;
  info.id = -1;
}

/** Unregistration of a sub class (the outer class's member goes with the outer class). */
export function unregisterSubClass<T extends object>(definition: NcbClassDefinition<T>): void {
  clearClassInfo(definition.info);
}

function globalMember(ctx: NcbContext, name: string): Dispatch | null {
  const global = ctx.exporter.TVPGetScriptDispatch();
  const slot = new VariantSlot();
  try {
    global.propGet(0, name, slot, global);
  } finally {
    global.release();
  }
  const v = slot.value;
  const dsp = v.type === 1 ? v.object : null;
  slot.clear();
  return dsp;
}

/** An attachment to an existing TJS class (`NCB_ATTACH_CLASS[_WITH_HOOK]`). */
export interface NcbAttachDefinition<T extends object> {
  readonly info: NcbClassInfo<T>;
  /** The TJS class the members go to (`Layer`, `Window`). */
  readonly tjs2Class: string;
  /** `NCB_GET_INSTANCE_HOOK`; without it methods find only an attached instance. */
  getInstance?(info: NcbClassInfo<T>, objthis: Dispatch): T | null;
  define(r: NcbRegistrar<T>): void;
}

/**
 * `NCB_ATTACH_CLASS`: adds members to the TJS class. Static members are set with the global
 * object as their context, as ncbind does.
 */
export function attachClass<T extends object>(
  ctx: NcbContext,
  definition: NcbAttachDefinition<T>,
): string[] {
  const info = definition.info;
  const ex = ctx.exporter;
  const target = globalMember(ctx, definition.tjs2Class);
  const id = ex.TJSRegisterNativeClass(info.name);
  if (info.id >= 0) ex.TVPThrowExceptionMessage('Already registerd class:', info.name);
  info.id = id;
  const names: string[] = [];
  const global = ex.TVPGetScriptDispatch();
  const set = (name: string, value: Variant, flags: number) => {
    if (!target) return;
    target.propSet(
      TJS_MEMBERENSURE | flags,
      name,
      value,
      flags & TJS_STATICMEMBER ? global : target,
    );
  };
  try {
    const r = new NcbRegistrar<T>(
      ctx,
      info,
      {
        item: (name, dsp, _type, flags) => {
          if (name === info.name) ex.TVPThrowExceptionMessage('Constructor attached: ', info.name);
          names.push(name);
          try {
            set(name, obj(dsp), flags);
          } finally {
            dsp.release();
          }
        },
        variant: (name, value, flags) => {
          names.push(name);
          set(name, value, flags);
        },
      },
      definition.getInstance ? (o) => definition.getInstance!(info, o) : undefined,
    );
    definition.define(r);
  } finally {
    global.release();
  }
  return names;
}

/** Detaches the members `attachClass` added. */
export function detachClass<T extends object>(
  ctx: NcbContext,
  definition: NcbAttachDefinition<T>,
  names: readonly string[],
): void {
  const target = globalMember(ctx, definition.tjs2Class);
  if (target) for (const name of names) target.deleteMember(0, name, target);
  definition.info.id = -1;
}

/** Whether `objthis` has the member (`TJS_MEMBERMUSTEXIST | TJS_IGNOREPROP`). */
export function hasMember(objthis: Dispatch, name: string): boolean {
  const slot = new VariantSlot();
  const hr = objthis.propGet(TJS_MEMBERMUSTEXIST | TJS_IGNOREPROP, name, slot, objthis);
  slot.clear();
  return !failed(hr);
}

/**
 * A plugin built with ncbind: `V2Link` runs the registrations, `V2Unlink` refuses while plugin
 * objects created after linking are alive, else runs the unregistrations.
 */
export abstract class NcbPlugin implements TvpPluginExports {
  readonly objects = new TvpPluginObjects();
  #linkedCount = 0;
  #ctx: NcbContext | null = null;

  protected get ctx(): NcbContext {
    if (!this.#ctx) throw new Error('The plugin is not linked');
    return this.#ctx;
  }

  /** `ncbAutoRegister::AllRegist` (pre-registration callbacks, classes, post callbacks). */
  protected abstract regist(ctx: NcbContext): void;
  /** `AllUnregist`. */
  protected abstract unregist(ctx: NcbContext): void;

  v2Link(exporter: TvpFunctionExporter): number {
    this.#ctx = {exporter, objects: this.objects};
    this.regist(this.#ctx);
    this.#linkedCount = this.objects.count;
    return TJS_S_OK;
  }

  v2Unlink(): number {
    if (this.objects.count > this.#linkedCount) return E_FAIL;
    this.unregist(this.ctx);
    this.#ctx = null;
    return TJS_S_OK;
  }
}

/** `GetDispatch`: a global, or a dotted path evaluated as an expression. */
function attachTarget(ctx: NcbContext, attach: string): Dispatch | null {
  const slot = new VariantSlot();
  if (attach.includes('.')) ctx.exporter.TVPExecuteExpression(attach, null, slot);
  else {
    const global = ctx.exporter.TVPGetScriptDispatch();
    global.propGet(0, attach, slot, global);
    global.release();
  }
  const v = slot.value;
  const dsp = v.type === 1 ? v.object : null;
  dsp?.addRef();
  slot.clear();
  return dsp;
}

/**
 * `NCB_ATTACH_FUNCTION(name, attach, function)`: `attach.name = function` with
 * `TJS_MEMBERENSURE` (not static, so instances made later copy it). A raw callback becomes a
 * core method object (`TJSCreateNativeClassMethod`).
 */
export function attachFunction(
  ctx: NcbContext,
  attach: string,
  name: string,
  body: (result: VariantResult | null, args: readonly Variant[], objthis: Dispatch) => number,
): void {
  const target = attachTarget(ctx, attach);
  if (!target) return;
  const dsp = ctx.exporter.TJSCreateNativeClassMethod((result, args, objthis) =>
    objthis ? body(result, args, objthis) : TJS_E_NATIVECLASSCRASH,
  );
  try {
    target.propSet(TJS_MEMBERENSURE, name, obj(dsp), target);
  } finally {
    dsp.release();
    target.release();
  }
}

/** Unregistration of `attachFunction`. */
export function detachFunction(ctx: NcbContext, attach: string, name: string): void {
  const target = attachTarget(ctx, attach);
  if (!target) return;
  target.deleteMember(0, name, target);
  target.release();
}

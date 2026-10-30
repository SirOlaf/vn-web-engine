/**
 * `tTJSInterCodeContext` (krkrz `tjsInterCodeGen.h`, `tjsInterCodeExec.cpp`): a compiled
 * context as a TJS object. Calling it runs its code; a property context answers property
 * access through its getter and setter; a class context creates instances with `new` and
 * looks up members it does not have in its base classes through the super-class getter.
 */
import {contextTypeName, ContextType, type CodeBlock, type ContextCode} from '../code-block.js';
import {CustomObject, TJS_NAMESPACE_DEFAULT_HASH_BITS} from '../runtime/custom-object.js';
import {closureFuncCall, DispatchBase} from '../runtime/dispatch.js';
import {
  TJS_E_ACCESSDENYED,
  TJS_E_INVALIDOBJECT,
  TJS_E_INVALIDTYPE,
  TJS_E_MEMBERNOTFOUND,
  TJS_E_SUSPENDED,
  TJS_IGNOREPROP,
  TJS_MEMBERENSURE,
  TJS_S_OK,
  TJS_S_TRUE,
  TJS_STATICMEMBER,
  type Dispatch,
  type Out,
  type Variant,
} from '../runtime/interface.js';
import {VariantSlot, releaseVariant} from '../runtime/slot.js';
import {throwTjsError} from '../runtime/errors.js';
import {
  asInt32,
  asObjectClosure,
  asString,
  int,
  obj,
  type ObjectVariant,
} from '../runtime/variant.js';
import type {Vm} from './vm.js';

/** `TJSGetContextHashSize`. */
function hashBits(type: ContextType): number {
  switch (type) {
    case ContextType.TopLevel:
    case ContextType.PropertySetter:
    case ContextType.PropertyGetter:
    case ContextType.SuperClassGetter:
      return 0;
    case ContextType.Function:
    case ContextType.ExprFunction:
    case ContextType.Property:
      return 1;
    default:
      return TJS_NAMESPACE_DEFAULT_HASH_BITS;
  }
}

export class InterCodeContext extends CustomObject {
  /** The data area; holds references. */
  data: Variant[] = [];
  parent: InterCodeContext | null = null;
  propGetter: InterCodeContext | null = null;
  propSetter: InterCodeContext | null = null;
  superClassGetter: InterCodeContext | null = null;
  /** Local variable slots allocated per call, at least `maxVariableCount`. */
  readonly variables: number;
  /** Temporary registers allocated per call, at least `maxFrameCount`. */
  readonly frameRegisters: number;

  constructor(
    readonly vm: Vm,
    readonly block: CodeBlock,
    readonly code: ContextCode,
    registers: {variables: number; frame: number},
  ) {
    super(hashBits(code.type));
    this.callFinalize = false;
    this.variables = registers.variables;
    this.frameRegisters = registers.frame;
  }

  get type(): ContextType {
    return this.code.type;
  }

  get name(): string | null {
    return this.code.name;
  }

  /** `GetShortDescription`: `(function) name`; accessors take their property's name. */
  shortDescription(): string {
    const accessor =
      this.type === ContextType.PropertySetter || this.type === ContextType.PropertyGetter;
    const name = accessor ? (this.parent?.name ?? null) : this.name;
    return `(${contextTypeName(this.type)})${name !== null ? ` ${name}` : ''}`;
  }

  protected override finalize(): void {
    this.propSetter?.release();
    this.propSetter = null;
    this.propGetter?.release();
    this.propGetter = null;
    this.superClassGetter?.release();
    this.superClassGetter = null;
    const data = this.data;
    this.data = [];
    for (const v of data) releaseVariant(v);
    super.finalize();
  }

  /** `RegisterObjectMember`: copies the members to a new instance, bound to it. */
  registerObjectMember(dest: Dispatch): void {
    const copier = new MemberCopier(dest);
    try {
      this.enumMembers(TJS_IGNOREPROP, obj(copier), this);
    } finally {
      copier.release();
    }
  }

  /**
   * `TJS_DO_SUPERCLASS_PROXY`: tries `call` on each base class, the last one first, until one
   * has the member. The base classes are what the super-class getter's entries evaluate to.
   */
  #superClassLookup(call: (base: ObjectVariant) => number): number {
    const getter = this.superClassGetter!;
    const pointers = getter.code.superClassGetterPointers;
    let hr = TJS_E_MEMBERNOTFOUND;
    for (let i = pointers.length - 1; i >= 0; i--) {
      const res = new VariantSlot();
      try {
        this.vm.suspender.nonSuspending(() =>
          this.vm.executeAsFunction(getter, null, [], res, pointers[i]!),
        );
        hr = call(asObjectClosure(res.value));
      } finally {
        res.clear();
      }
      if (hr !== TJS_E_MEMBERNOTFOUND) break;
    }
    return hr;
  }

  #hasSuperClass(member: string | null): boolean {
    return member !== null && this.type === ContextType.Class && this.superClassGetter !== null;
  }

  override funcCall(
    flag: number,
    member: string | null,
    result: VariantSlot | null,
    args: readonly Variant[],
    objthis: Dispatch | null,
  ): number {
    if (!this.validity) return TJS_E_INVALIDOBJECT;
    if (member === null) {
      switch (this.type) {
        case ContextType.TopLevel:
          return this.vm.executeAsFunction(this, objthis ?? this.vm.engine.global, [], result, 0);
        case ContextType.Function:
        case ContextType.ExprFunction:
        case ContextType.PropertyGetter:
        case ContextType.PropertySetter:
        case ContextType.Class:
          return this.vm.executeAsFunction(this, objthis, args, result, 0);
        case ContextType.Property:
          return TJS_E_INVALIDTYPE;
      }
      return TJS_S_OK;
    }
    let hr = super.funcCall(flag, member, result, args, objthis);
    if (hr === TJS_E_MEMBERNOTFOUND && this.#hasSuperClass(member))
      hr = this.#superClassLookup((c) => closureFuncCall(c, flag, member, result, args, objthis));
    return hr;
  }

  override propGet(
    flag: number,
    member: string | null,
    result: VariantSlot | null,
    objthis: Dispatch | null,
  ): number {
    if (!this.validity) return TJS_E_INVALIDOBJECT;
    if (member === null && this.type === ContextType.Property) {
      if (!this.propGetter) return TJS_E_ACCESSDENYED;
      return this.propGetter.funcCall(0, null, result, [], objthis);
    }
    let hr = super.propGet(flag, member, result, objthis);
    if (hr === TJS_E_MEMBERNOTFOUND && this.#hasSuperClass(member))
      hr = this.#superClassLookup((c) =>
        c.object
          ? c.object.propGet(flag, member, result, c.objthis ?? objthis ?? c.object)
          : nullAccess(),
      );
    return hr;
  }

  override propSet(
    flag: number,
    member: string | null,
    value: Variant,
    objthis: Dispatch | null,
  ): number {
    if (!this.validity) return TJS_E_INVALIDOBJECT;
    if (member === null && this.type === ContextType.Property) {
      if (!this.propSetter) return TJS_E_ACCESSDENYED;
      return this.propSetter.funcCall(0, null, null, [value], objthis);
    }
    if (!this.#hasSuperClass(member)) return super.propSet(flag, member, value, objthis);
    // Member ensuring waits until no base class has the member, unless TJS_IGNOREPROP.
    const pseudo = flag & TJS_IGNOREPROP ? flag : flag & ~TJS_MEMBERENSURE;
    let hr = super.propSet(pseudo, member, value, objthis);
    if (hr === TJS_E_MEMBERNOTFOUND)
      hr = this.#superClassLookup((c) =>
        c.object
          ? c.object.propSet(pseudo, member, value, c.objthis ?? objthis ?? c.object)
          : nullAccess(),
      );
    if (hr === TJS_E_MEMBERNOTFOUND && flag & TJS_MEMBERENSURE)
      hr = super.propSet(flag, member, value, objthis);
    return hr;
  }

  override createNew(
    flag: number,
    member: string | null,
    result: Out<Dispatch | null>,
    args: readonly Variant[],
    objthis: Dispatch | null,
  ): number {
    if (!this.validity) return TJS_E_INVALIDOBJECT;
    if (member === null) {
      if (this.type !== ContextType.Class) return TJS_E_INVALIDTYPE;
      return this.#construct(result, args);
    }
    let hr = super.createNew(flag, member, result, args, objthis);
    if (hr === TJS_E_MEMBERNOTFOUND && this.#hasSuperClass(member))
      hr = this.#superClassLookup((c) =>
        c.object
          ? c.object.createNew(flag, member, result, args, c.objthis ?? objthis ?? c.object)
          : nullAccess(),
      );
    return hr;
  }

  /**
   * `new` of a class: a plain object runs the class body (base classes, members, `var`s), then
   * the constructor, the member named after the class, is called on it. Its result code is
   * ignored, so a class without a constructor is fine. Both steps may suspend.
   */
  #construct(result: Out<Dispatch | null>, args: readonly Variant[]): number {
    const suspender = this.vm.suspender;
    const dsp = new CustomObject();
    const fail = (e: unknown): never => {
      dsp.release();
      throw e;
    };
    const done = (): number => {
      result.value = dsp;
      return TJS_S_OK;
    };
    const construct = (): number => {
      let hr: number;
      try {
        hr = this.funcCall(0, this.name, null, args, dsp);
      } catch (e) {
        return fail(e);
      }
      if (hr === TJS_E_SUSPENDED)
        return suspender.defer((o) => ('error' in o ? fail(o.error) : done()));
      return done();
    };
    let hr: number;
    try {
      hr = this.vm.executeAsFunction(this, dsp, [], null, 0);
    } catch (e) {
      return fail(e);
    }
    if (hr === TJS_E_SUSPENDED)
      return suspender.defer((o) => ('error' in o ? fail(o.error) : construct()));
    return construct();
  }

  override isInstanceOf(
    flag: number,
    member: string | null,
    className: string,
    objthis: Dispatch | null,
  ): number {
    if (!this.validity) return TJS_E_INVALIDOBJECT;
    if (member === null) {
      switch (this.type) {
        case ContextType.Function:
        case ContextType.ExprFunction:
          if (className === 'Function') return TJS_S_TRUE;
          break;
        case ContextType.Property:
          if (className === 'Property') return TJS_S_TRUE;
          break;
        case ContextType.Class:
          if (className === 'Class') return TJS_S_TRUE;
          break;
      }
    }
    let hr = super.isInstanceOf(flag, member, className, objthis);
    if (hr === TJS_E_MEMBERNOTFOUND && this.#hasSuperClass(member))
      hr = this.#superClassLookup((c) =>
        c.object
          ? c.object.isInstanceOf(flag, member, className, c.objthis ?? objthis ?? c.object)
          : nullAccess(),
      );
    return hr;
  }

  override getCount(result: Out<number>, member: string | null, objthis: Dispatch | null): number {
    let hr = super.getCount(result, member, objthis);
    if (hr === TJS_E_MEMBERNOTFOUND && this.#hasSuperClass(member))
      hr = this.#superClassLookup((c) =>
        c.object
          ? c.object.getCount(result, member, c.objthis ?? objthis ?? c.object)
          : nullAccess(),
      );
    return hr;
  }

  override deleteMember(flag: number, member: string | null, objthis: Dispatch | null): number {
    let hr = super.deleteMember(flag, member, objthis);
    if (hr === TJS_E_MEMBERNOTFOUND && this.#hasSuperClass(member))
      hr = this.#superClassLookup((c) =>
        c.object
          ? c.object.deleteMember(flag, member, c.objthis ?? objthis ?? c.object)
          : nullAccess(),
      );
    return hr;
  }

  override invalidate(flag: number, member: string | null, objthis: Dispatch | null): number {
    let hr = super.invalidate(flag, member, objthis);
    if (hr === TJS_E_MEMBERNOTFOUND && this.#hasSuperClass(member))
      hr = this.#superClassLookup((c) =>
        c.object
          ? c.object.invalidate(flag, member, c.objthis ?? objthis ?? c.object)
          : nullAccess(),
      );
    return hr;
  }

  override isValid(flag: number, member: string | null, objthis: Dispatch | null): number {
    let hr = super.isValid(flag, member, objthis);
    if (hr === TJS_E_MEMBERNOTFOUND && this.#hasSuperClass(member))
      hr = this.#superClassLookup((c) =>
        c.object ? c.object.isValid(flag, member, c.objthis ?? objthis ?? c.object) : nullAccess(),
      );
    return hr;
  }

  override operation(
    flag: number,
    member: string | null,
    result: VariantSlot | null,
    param: Variant | null,
    objthis: Dispatch | null,
  ): number {
    if (member === null) {
      // A property object reads, changes and writes itself through its handlers.
      if (this.type === ContextType.Property)
        return DispatchBase.prototype.operation.call(this, flag, member, result, param, objthis);
      return super.operation(flag, member, result, param, objthis);
    }
    if (!this.#hasSuperClass(member)) return super.operation(flag, member, result, param, objthis);
    const pseudo = flag & TJS_IGNOREPROP ? flag : flag & ~TJS_MEMBERENSURE;
    let hr = super.operation(pseudo, member, result, param, objthis);
    if (hr === TJS_E_MEMBERNOTFOUND)
      hr = this.#superClassLookup((c) =>
        c.object
          ? c.object.operation(pseudo, member, result, param, c.objthis ?? objthis ?? c.object)
          : nullAccess(),
      );
    if (hr === TJS_E_MEMBERNOTFOUND) hr = super.operation(flag, member, result, param, objthis);
    return hr;
  }
}

function nullAccess(): never {
  return throwTjsError('TJSNullAccess');
}

/** The callback of `RegisterObjectMember`: copies non-static members, bound to `dest`. */
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
      if (v.type === 1) v = obj(v.object, this.dest);
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

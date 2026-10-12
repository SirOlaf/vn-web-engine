/**
 * The TJS2 script engine object (`tTJS`, krkrz `tjs.cpp`): the global object with the built-in
 * classes, the suspension state shared by every native, and the host services the core
 * provides to TJS (text streams for `Array.load`/`saveStruct`, console output).
 */
import {ARRAY_CLASS_ID, ArrayClass, ArrayObject, instanceOf} from './builtins/array.js';
import {DICTIONARY_CLASS_ID, DictionaryClass, DictionaryObject} from './builtins/dictionary.js';
import {ExceptionClass} from './builtins/exception.js';
import {MathClass, MsvcRand, RandomGeneratorClass} from './builtins/math.js';
import {CustomObject} from './custom-object.js';
import {throwTjsError, TjsError} from './errors.js';
import {
  failed,
  TJS_MEMBERENSURE,
  type Dispatch,
  type Out,
  type VariantResult,
} from './interface.js';
import {VariantSlot} from './slot.js';
import {Suspender} from './suspension.js';
import {NULL_OBJECT, obj, str, type Variant} from './variant.js';

const TJS_GLOBAL_HASH_BITS = 7;

/** `iTJSTextWriteStream`. */
export interface TjsTextWriter {
  write(text: string): void;
  /** `Destruct`: flushes and closes. */
  close(): void;
}

/** Services the core gives the script engine (`TJSCreateTextStreamFor*`, console). */
export interface TjsHost {
  /**
   * `TJSCreateTextStreamForRead(name, mode)` and `Read(all)`: the decoded text of a storage.
   * A promise when the storage is not available synchronously; the caller suspends.
   */
  readText(name: string, mode: string): string | Promise<string>;
  /** `TJSCreateTextStreamForWrite(name, mode)`. */
  openTextWrite(name: string, mode: string): TjsTextWriter;
  /** `iTJSConsoleOutput::Print`. */
  print(line: string): void;
  /** `time()`: seconds since 1970, for seeds. */
  time(): number;
  /** `TJSGetRandomBits128`: 16 bytes of entropy; absent, seeds come from `time()`. */
  randomBits128?(): Uint8Array;
}

/** A script block to run: a storage's text, or a string given to `Scripts.exec`/`eval`. */
export interface TjsScriptBlock {
  readonly text: string;
  /** The block name for errors and traces (the storage name without its path). */
  readonly name: string;
  readonly lineOffset: number;
  /** `ExecScript` (statements) or `EvalExpression` (an expression, whose value is the result). */
  readonly mode: 'statements' | 'expression';
}

/**
 * Compiles and runs script blocks (`tTJS::ExecScript`, `EvalExpression`, `LoadByteCode`). The
 * top level runs with `this` = `context` or the global object. May suspend.
 */
export interface TjsScriptExecutor {
  run(block: TjsScriptBlock, result: VariantResult | null, context: Dispatch | null): number;
  /**
   * Runs TJS2 bytecode (`TJS2100`). Returns the result code (which may be
   * `TJS_E_SUSPENDED`), or null when `bytes` is not bytecode.
   */
  runByteCode(
    bytes: Uint8Array,
    name: string,
    result: VariantResult | null,
    context: Dispatch | null,
  ): number | null;
}

export class TjsEngine {
  /** Set by the VM. Until one is installed, running a script throws. */
  executor: TjsScriptExecutor | null = null;
  readonly global: CustomObject;
  readonly suspender = new Suspender();
  /** The CRT `rand` state, shared by every native that calls `rand`. */
  readonly crtRand = new MsvcRand();
  readonly arrayClass: ArrayClass;
  readonly dictionaryClass: DictionaryClass;

  constructor(readonly host: TjsHost) {
    this.global = new CustomObject(TJS_GLOBAL_HASH_BITS);
    this.arrayClass = new ArrayClass(this);
    this.dictionaryClass = new DictionaryClass(this);
    this.#register('Array', this.arrayClass);
    this.arrayClass.addRef();
    this.#register('Dictionary', this.dictionaryClass);
    this.dictionaryClass.addRef();
    // Date follows Dictionary natively; it is registered by the date module when present.
    const math = new MathClass(this);
    this.#register('Math', math);
    const random = new RandomGeneratorClass(this);
    math.propSet(TJS_MEMBERENSURE, 'RandomGenerator', obj(random), math);
    random.release();
    this.#register('Exception', new ExceptionClass());
  }

  /** Sets a global member and hands over the caller's reference on `dsp`. */
  #register(name: string, dsp: Dispatch): void {
    this.global.propSet(TJS_MEMBERENSURE, name, obj(dsp), this.global);
    dsp.release();
  }

  /** Adds a class or object to the global object, as the core does at start-up. */
  registerGlobal(name: string, dsp: Dispatch): void {
    this.#register(name, dsp);
  }

  /** `TJSCreateArrayObject`: a new Array, owned by the caller. */
  createArray(): ArrayObject {
    return this.#createNew(this.arrayClass) as ArrayObject;
  }

  /** `TJSCreateDictionaryObject`: a new Dictionary, owned by the caller. */
  createDictionary(): DictionaryObject {
    return this.#createNew(this.dictionaryClass) as DictionaryObject;
  }

  #createNew(cls: Dispatch): Dispatch {
    const out: Out<Dispatch | null> = {value: null};
    if (failed(cls.createNew(0, null, out, [], cls)) || !out.value)
      throwTjsError('TJSNativeClassCrash');
    return out.value;
  }

  /**
   * `TJSGetExceptionObject`: `new global.Exception(message)`, with `trace` set when given.
   * The returned variant holds the caller's reference.
   */
  exceptionObject(message: string, trace?: string): Variant {
    const cls = new VariantSlot();
    try {
      if (failed(this.global.propGet(0, 'Exception', cls, this.global)))
        throwTjsError('TJSExceptionNotFound');
      const clo = cls.value;
      if (clo.type !== 1 || !clo.object) return throwTjsError('TJSExceptionNotFound');
      const out: Out<Dispatch | null> = {value: null};
      if (failed(clo.object.createNew(0, null, out, [str(message)], clo.objthis)) || !out.value)
        throwTjsError('TJSExceptionNotFound');
      const e = out.value;
      if (trace !== undefined) e.propSet(TJS_MEMBERENSURE, 'trace', str(trace), e);
      // tTJSVariant(excpobj, excpobj): two references, then the creation reference is dropped.
      e.addRef();
      return obj(e, e);
    } finally {
      cls.clear();
    }
  }

  /**
   * For `assignStruct`: a new, empty container to copy a nested Array or Dictionary into, and
   * the function that fills it. `object` holds the creation reference; the caller releases it
   * once the copy is stored. Null object variant on recursion; null for values that are shared.
   */
  newStructuredCopy(
    v: Variant,
    stack: Dispatch[],
  ): {value: Variant; object: Dispatch | null; fill(): void} | null {
    if (v.type !== 1) return null;
    const dsp = v.object;
    if (dsp && instanceOf(dsp, DICTIONARY_CLASS_ID)) {
      if (stack.includes(dsp)) return {value: NULL_OBJECT, object: null, fill() {}};
      const d = this.createDictionary();
      return {
        value: obj(d, d),
        object: d,
        fill: () => this.dictionaryClass.assignStructure(d, dsp, stack),
      };
    }
    if (dsp && instanceOf(dsp, ARRAY_CLASS_ID)) {
      if (stack.includes(dsp)) return {value: NULL_OBJECT, object: null, fill() {}};
      const a = this.createArray();
      return {
        value: obj(a, a),
        object: a,
        fill: () => this.arrayClass.assignStructure(a, a.ni, dsp, stack),
      };
    }
    return null;
  }

  /** `tTJS::ExecScript` / `EvalExpression`. */
  runScript(block: TjsScriptBlock, result: VariantResult | null, context: Dispatch | null): number {
    if (!this.executor)
      throw new TjsError(`No TJS2 VM to run ${block.name || '(no-named script block)'}`);
    return this.executor.run(block, result, context);
  }

  /** `tTJS::Shutdown`: clears the global object. */
  shutdown(): void {
    this.global.clear();
  }
}

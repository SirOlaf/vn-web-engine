/** `Scripts` (krkrz `tTJSNC_Scripts`, `ScriptMgnIntf.cpp`) and `TVPExecuteStorage`. */
import {throwTjsError, TjsError} from '../../tjs2/runtime/errors.js';
import {
  TJS_CII_GET,
  TJS_CII_SET_MISSING,
  TJS_E_BADPARAMCOUNT,
  TJS_E_FAIL,
  TJS_MEMBERENSURE,
  TJS_S_OK,
  type Dispatch,
  type VariantResult,
} from '../../tjs2/runtime/interface.js';
import {NativeClass} from '../../tjs2/runtime/native.js';
import {VariantSlot} from '../../tjs2/runtime/slot.js';
import {asInt32, asObject, asString, obj, str} from '../../tjs2/runtime/variant.js';
import type {TjsEngine} from '../../tjs2/runtime/engine.js';
import {extractStorageName, type StorageSystem} from '../storage.js';
import {readWholeStream} from '../streams.js';
import {decodeTextStorage, type TextReadOptions} from '../text-stream.js';
import {TJS_BS_READ} from '../../tjs2/runtime/interface.js';

/** What `Scripts` and `TVPExecuteStorage` use of the core. */
export interface ScriptsServices {
  readonly engine: TjsEngine;
  readonly storage: StorageSystem;
  /** `TVPScriptTextEncoding` (`Scripts.textEncoding`), and how to decode ANSI text. */
  scriptTextOptions(): TextReadOptions;
  setScriptTextEncoding(encoding: string): void;
  /** `TVPDumpScriptEngine`. */
  dump(): void;
  /** `TJSGetStackTraceString(limit)`. */
  stackTrace(limit: number): string;
}

/**
 * `TVPExecuteStorage`: runs a storage as TJS2 bytecode if it is bytecode, else as script text
 * (statements, or an expression for `evalStorage`). Suspends while the storage is read.
 */
export function executeStorage(
  services: ScriptsServices,
  name: string,
  context: Dispatch | null,
  result: VariantResult | null,
  isExpression: boolean,
  mode = '',
): number {
  const {engine, storage} = services;
  const place = storage.searchPlacedPath(name);
  const shortName = extractStorageName(place);
  const run = (bytes: Uint8Array): number => {
    const hr = engine.executor?.runByteCode(bytes, shortName, result, context) ?? null;
    if (hr !== null) return hr;
    const text = decodeTextStorage(place, bytes, mode, services.scriptTextOptions());
    const exec = (t: string) =>
      engine.runScript(
        {text: t, name: shortName, lineOffset: 0, mode: isExpression ? 'expression' : 'statements'},
        result,
        context,
      );
    return text instanceof Promise ? engine.suspender.suspend(text, exec) : exec(text);
  };
  const opened = storage.createStream(place, TJS_BS_READ);
  const read = (stream: Awaited<typeof opened>) => {
    const bytes = readWholeStream(stream);
    if (bytes instanceof Promise)
      return engine.suspender.suspend(bytes, (b) => (stream.destruct(), run(b)));
    stream.destruct();
    return run(bytes);
  };
  return opened instanceof Promise ? engine.suspender.suspend(opened, read) : read(opened);
}

export function createScriptsClass(services: ScriptsServices): NativeClass {
  const {engine} = services;
  const cls = new NativeClass('Scripts', () => throwTjsError('TVPCannotCreateInstance'));
  const contextArg = (
    args: readonly import('../../tjs2/runtime/interface.js').Variant[],
    n: number,
  ) => (args.length > n && args[n]!.type !== 0 ? asObject(args[n]!) : null);
  cls.emptyFinalize();
  cls.constructorMethod(() => TJS_S_OK);
  const storageRunner = (isExpression: boolean) =>
    cls.staticMethod(isExpression ? 'evalStorage' : 'execStorage', (result, args) => {
      if (args.length < 1) return TJS_E_BADPARAMCOUNT;
      const name = asString(args[0]!);
      const mode = args.length >= 2 && args[1]!.type !== 0 ? asString(args[1]!) : '';
      return executeStorage(services, name, contextArg(args, 2), result, isExpression, mode);
    });
  storageRunner(false);
  storageRunner(true);
  cls.staticMethod('compileStorage', (_result, args) => {
    if (args.length < 2) return TJS_E_BADPARAMCOUNT;
    // Writing TJS2 bytecode needs the code generator.
    throw new TjsError('Scripts.compileStorage: TJS2 bytecode output is not available');
  });
  const textRunner = (isExpression: boolean) =>
    cls.staticMethod(isExpression ? 'eval' : 'exec', (result, args) => {
      if (args.length < 1) return TJS_E_BADPARAMCOUNT;
      const text = asString(args[0]!);
      const name = args.length >= 2 && args[1]!.type !== 0 ? asString(args[1]!) : '';
      const lineOffset = args.length >= 3 && args[2]!.type !== 0 ? asInt32(args[2]!) : 0;
      return engine.runScript(
        {text, name, lineOffset, mode: isExpression ? 'expression' : 'statements'},
        result,
        contextArg(args, 3),
      );
    });
  textRunner(false);
  textRunner(true);
  cls.staticMethod('dump', () => {
    services.dump();
    return TJS_S_OK;
  });
  cls.staticMethod('getTraceString', (result, args) => {
    const limit = args.length >= 1 && args[0]!.type !== 0 ? asInt32(args[0]!) : 0;
    if (result) result.set(str(services.stackTrace(limit)));
    return TJS_S_OK;
  });
  cls.staticMethod('dumpStringHeap', () => TJS_S_OK); // a debug build feature; no-op natively
  cls.staticMethod('setCallMissing', (_result, args) => {
    if (args.length < 1) return TJS_E_BADPARAMCOUNT;
    const dsp = asObject(args[0]!);
    if (dsp) {
      const missing = new VariantSlot(str('missing'));
      dsp.classInstanceInfo(TJS_CII_SET_MISSING, 0, missing);
      missing.clear();
    }
    return TJS_S_OK;
  });
  cls.staticMethod('getClassNames', (result, args) => {
    if (args.length < 1) return TJS_E_BADPARAMCOUNT;
    const dsp = asObject(args[0]!);
    if (!dsp) return TJS_E_FAIL;
    const array = engine.createArray();
    try {
      const val = new VariantSlot();
      for (let num = 0; ; num++) {
        if (dsp.classInstanceInfo(TJS_CII_GET, num, val) < 0) break;
        array.propSetByNum(TJS_MEMBERENSURE, num, val.value, array);
      }
      val.clear();
      result?.set(obj(array, array));
    } finally {
      array.release();
    }
    return TJS_S_OK;
  });
  cls.staticProperty('textEncoding', {
    get: (result) => (result.set(str(services.scriptTextOptions().encoding)), TJS_S_OK),
    set: (value) => (services.setScriptTextEncoding(asString(value)), TJS_S_OK),
  });
  return cls;
}

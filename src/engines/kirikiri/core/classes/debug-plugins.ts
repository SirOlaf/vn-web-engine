/** `Debug` (krkrz `utils/DebugIntf.cpp`) and `Plugins` (`base/win32/PluginImpl.cpp`). */
import {TJS_E_BADPARAMCOUNT, TJS_MEMBERENSURE, TJS_S_OK} from '../../tjs2/runtime/interface.js';
import {NativeClass} from '../../tjs2/runtime/native.js';
import {throwTjsError} from '../../tjs2/runtime/errors.js';
import {
  asBoolean,
  asInteger,
  asObjectClosure,
  asString,
  bool,
  obj,
  str,
} from '../../tjs2/runtime/variant.js';
import type {TjsEngine} from '../../tjs2/runtime/engine.js';
import type {TvpLog} from '../log.js';
import type {PluginManager} from '../plugins.js';

export interface DebugServices {
  readonly log: TvpLog;
  /** `TVPLogLocation`, and `TVPSetLogLocation`. */
  logLocation(): string;
  setLogLocation(location: string): void;
}

export function createDebugClass(services: DebugServices): NativeClass {
  const {log} = services;
  const cls = new NativeClass('Debug', () => throwTjsError('TVPCannotCreateInstance'));
  const joined = (args: readonly Parameters<typeof asString>[0][]) =>
    args.length === 1 ? asString(args[0]!) : args.map(asString).join(', ');
  cls.emptyFinalize();
  cls.staticMethod('message', (_result, args) => {
    if (args.length < 1) return TJS_E_BADPARAMCOUNT;
    log.add(joined(args));
    return TJS_S_OK;
  });
  cls.staticMethod('notice', (_result, args) => {
    if (args.length < 1) return TJS_E_BADPARAMCOUNT;
    log.add(joined(args), true);
    return TJS_S_OK;
  });
  cls.staticMethod('startLogToFile', (_result, args) => {
    log.startLogToFile(args.length >= 1 ? asBoolean(args[0]!) : false);
    return TJS_S_OK;
  });
  cls.staticMethod('logAsError', () => {
    log.onError();
    return TJS_S_OK;
  });
  cls.staticMethod('addLoggingHandler', (_result, args) => {
    if (args.length < 1) return TJS_E_BADPARAMCOUNT;
    log.addHandler(asObjectClosure(args[0]!));
    return TJS_S_OK;
  });
  cls.staticMethod('removeLoggingHandler', (_result, args) => {
    if (args.length < 1) return TJS_E_BADPARAMCOUNT;
    log.removeHandler(asObjectClosure(args[0]!));
    return TJS_S_OK;
  });
  cls.staticMethod('getLastLog', (result, args) => {
    const lines = args.length >= 1 ? Number(BigInt.asUintN(32, asInteger(args[0]!))) : 2048 + 100;
    if (result) result.set(str(log.lastLog(lines)));
    return TJS_S_OK;
  });
  cls.staticProperty('logLocation', {
    get: (result) => (result.set(str(services.logLocation())), TJS_S_OK),
    set: (value) => (services.setLogLocation(asString(value)), TJS_S_OK),
  });
  cls.staticProperty('logToFileOnError', {
    get: (result) => (result.set(bool(log.autoLogToFileOnError)), TJS_S_OK),
    set: (value) => ((log.autoLogToFileOnError = asBoolean(value)), TJS_S_OK),
  });
  cls.staticProperty('clearLogFileOnError', {
    get: (result) => (result.set(bool(log.autoClearLogOnError)), TJS_S_OK),
    set: (value) => ((log.autoClearLogOnError = asBoolean(value)), TJS_S_OK),
  });
  return cls;
}

export function createPluginsClass(engine: TjsEngine, plugins: PluginManager): NativeClass {
  const cls = new NativeClass('Plugins', () => throwTjsError('TVPCannotCreateInstance'));
  cls.emptyFinalize();
  cls.staticMethod('link', (_result, args) => {
    if (args.length < 1) return TJS_E_BADPARAMCOUNT;
    const pending = plugins.load(asString(args[0]!));
    return pending ? engine.suspender.suspend(pending, () => TJS_S_OK) : TJS_S_OK;
  });
  cls.staticMethod('unlink', (result, args) => {
    if (args.length < 1) return TJS_E_BADPARAMCOUNT;
    const res = plugins.unload(asString(args[0]!));
    result?.set(bool(res));
    return TJS_S_OK;
  });
  cls.staticMethod('getList', (result) => {
    const array = engine.createArray();
    try {
      plugins.names.forEach((name, i) => array.propSetByNum(TJS_MEMBERENSURE, i, str(name), array));
      result?.set(obj(array, array));
    } finally {
      array.release();
    }
    return TJS_S_OK;
  });
  return cls;
}

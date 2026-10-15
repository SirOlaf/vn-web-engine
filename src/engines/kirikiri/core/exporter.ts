/**
 * The function exporter (`iTVPFunctionExporter`, `TVPInitExportFuncs`): the core functions a
 * plugin's `tp_stub` imports by C++ signature. `has` answers from the executable's table; the
 * members implement the functions plugins of the supported titles call.
 */
import type {TjsEngine} from '../tjs2/runtime/engine.js';
import {check, TjsError, tjsMessage} from '../tjs2/runtime/errors.js';
import {
  type CreateNativeInstanceCallback,
  type Dispatch,
  type NativeClassObject,
  type TvpFunctionExporter,
  type TvpStorageMedia,
} from '../tjs2/runtime/interface.js';
import {
  findNativeClassId,
  findNativeClassName,
  NativeClass,
  NativeClassConstructor,
  NativeClassMethod,
  NativeClassProperty,
  PluginNativeClass,
  registerNativeClass,
  type NativeMethodCallback,
} from '../tjs2/runtime/native.js';
import {tjsDoRehash} from '../tjs2/runtime/custom-object.js';
import type {KirikiriMessageName} from '../messages.js';
import type {TvpEventSystem} from './events.js';
import type {TvpLog} from './log.js';
import {extractStorageName, extractStoragePath, type StorageSystem} from './storage.js';
import type {TvpMemory} from './visual/memory.js';

/** What the exporter reaches in the core. */
export interface TvpExporterServices {
  readonly names: ReadonlySet<string>;
  readonly engine: TjsEngine;
  readonly storage: StorageSystem;
  readonly log: TvpLog;
  readonly events: TvpEventSystem;
  readonly memory: TvpMemory;
  getCommandLine(name: string): string | null;
  setCommandLine(name: string, value: string): void;
  appPath(): string;
  readText(name: string, mode: string): string | Promise<string>;
  asyncKeyState(keyCode: number, getCurrent: boolean): boolean;
  /** The `HWND` of the first window of the application's window list, or null. */
  firstWindowHandle(): number | null;
  clearGraphicCache(): void;
  temporaryName(): string;
  encodeAnsi(text: string): Uint8Array;
  aboutString(): string;
}

/** `TVPThrowExceptionMessage`'s `%1`, `%2`… substitution (`TVPFormatMessage`). */
function formatMessage(message: string, params: readonly string[]): string {
  let out = '';
  for (let i = 0; i < message.length; i++) {
    const c = message[i]!;
    if (c === '%' && i + 1 < message.length) {
      const d = message[i + 1]!;
      if (d === '%') {
        out += '%';
        i++;
        continue;
      }
      if (d >= '1' && d <= '9') {
        const n = d.charCodeAt(0) - 0x31;
        if (n < params.length) {
          out += params[n];
          i++;
          continue;
        }
      }
    }
    out += c;
  }
  return out;
}

function ownClass(cls: NativeClassObject): NativeClass {
  if (!(cls instanceof NativeClass)) throw new TjsError('Not a native class of this core');
  return cls;
}

export function createFunctionExporter(s: TvpExporterServices): TvpFunctionExporter {
  const storage = s.storage;
  const blocks = new Map<number, number>();
  const malloc = (size: number): number => {
    const address = s.memory.allocate(size, 'TVP_malloc');
    blocks.set(address, size);
    return address;
  };
  const free = (address: number): void => {
    if (!address) return;
    const size = blocks.get(address);
    if (size === undefined) throw new TjsError('TVP_free: not a TVP_malloc block');
    blocks.delete(address);
    s.memory.free(address, size);
  };
  return {
    has: (signature) => s.names.has(signature),
    suspend: (promise, then) => s.engine.suspender.suspend(promise, then),
    TVPGetScriptDispatch: () => {
      s.engine.global.addRef();
      return s.engine.global;
    },
    TJSCreateArrayObject: () => s.engine.createArray(),
    TJSCreateDictionaryObject: () => s.engine.createDictionary(),
    TVPAddLog: (message) => s.log.add(message),
    TVPAddImportantLog: (message) => s.log.add(message, true),
    TVPGetCommandLine: (name) => s.getCommandLine(name),
    TVPSetCommandLine: (name, value) => s.setCommandLine(name, value),
    TVPGetAppPath: () => s.appPath(),
    TVPRegisterStorageMedia: (media: TvpStorageMedia) => storage.registerMedia(media),
    TVPUnregisterStorageMedia: (media: TvpStorageMedia) => storage.unregisterMedia(media),
    TVPSetCurrentDirectory: (name) => storage.setCurrentDirectory(name),
    TVPNormalizeStorageName: (name) => storage.normalize(name),
    TVPExtractStorageName: extractStorageName,
    TVPExtractStoragePath: extractStoragePath,
    TVPAddAutoPath: (name) => storage.addAutoPath(name),
    TVPRemoveAutoPath: (name) => storage.removeAutoPath(name),
    TVPClearStorageCaches: () => storage.clearStorageCaches(),
    TVPIsExistentStorage: (name) => storage.isExistentStorage(name),
    TVPCreateStream: (name, flags) => storage.createStream(name, flags),
    TVPGetPlacedPath: (name) => storage.getPlacedPath(name),
    TVPGetLocalName: (name) => storage.getLocalName(storage.normalize(name)),
    TVPIsExistentStorageNoSearchNoNormalize: (name) =>
      storage.isExistentStorageNoSearchNoNormalize(name),
    TVPCreateTextStreamForRead: (name, mode) => s.readText(name, mode),
    TVPGetTemporaryName: () => s.temporaryName(),
    TJSNarrowString: (text) => s.encodeAnsi(text),
    TVPGetAboutString: () => s.aboutString(),

    TJSRegisterNativeClass: registerNativeClass,
    TJSFindNativeClassID: findNativeClassId,
    TJSFindNativeClassName: findNativeClassName,
    TJSCreateNativeClassMethod: (callback) =>
      new NativeClassMethod(callback as NativeMethodCallback),
    TJSCreateNativeClassConstructor: (callback) => new NativeClassConstructor(callback),
    TJSCreateNativeClassProperty: (get, set) =>
      new NativeClassProperty(get ?? undefined, set ?? undefined),
    TJSCreateNativeClassForPlugin: (name, create: CreateNativeInstanceCallback) =>
      new PluginNativeClass(name, create),
    TJSNativeClassSetClassID: (cls, id) => {
      ownClass(cls).classId = id;
    },
    // tTJSNativeClass::RegisterNCM: the member is set with TJS_MEMBERENSURE | TJS_IGNOREPROP
    // and the flags; the class takes over the reference. The class name and type only name
    // the object for the object hash map, which this core does not keep.
    TJSNativeClassRegisterNCM: (cls, name, dsp, _className, _type, flags) =>
      ownClass(cls).registerMember(name, dsp, flags),

    TVPThrowExceptionMessage: (message, ...params) => {
      throw new TjsError(formatMessage(message, params));
    },
    TVPExecuteExpression: (content, context, result) => {
      check(
        s.engine.runScript(
          {text: content, name: '', lineOffset: 0, mode: 'expression'},
          result,
          context,
        ),
      );
    },
    TJSGetMessageMapMessage: (name) => {
      try {
        return tjsMessage(name as KirikiriMessageName);
      } catch {
        return '';
      }
    },
    TJSDoRehash: () => tjsDoRehash(),

    TVPPostEvent: (source: Dispatch, target: Dispatch, eventName, tag, flag, args) => {
      check(s.events.postEvent(source, target, eventName, tag, flag, args));
    },
    TVPAddCompactEventHook: (callback) => s.events.addCompactEventHook(callback),
    TVPRemoveCompactEventHook: (callback) => s.events.removeCompactEventHook(callback),
    // Natively a message loop runs inside the call; a browser host delivers its messages only
    // after the current task, so there is nothing to deliver here.
    TVPBreathe: () => {},
    TVPGetBreathing: () => false,

    TVPGetAsyncKeyState: (keyCode, getCurrent) => s.asyncKeyState(keyCode, getCurrent),
    // INVALID_HANDLE_VALUE without windows, as the reference build returns.
    TVPGetApplicationWindowHandle: () => s.firstWindowHandle() ?? -1,
    TVPClearGraphicCache: () => s.clearGraphicCache(),

    TVP_malloc: malloc,
    TVP_realloc: (address, size) => {
      const next = malloc(size);
      if (address) {
        const old = blocks.get(address);
        if (old === undefined) throw new TjsError('TVP_realloc: not a TVP_malloc block');
        const u8 = s.memory.u8;
        u8.copyWithin(next, address, address + Math.min(old, size));
        free(address);
      }
      return next;
    },
    TVP_free: free,
  };
}

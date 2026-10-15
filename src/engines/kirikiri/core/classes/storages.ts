/** `Storages` (krkrz `tTJSNC_Storages`, `StorageIntf.cpp` and `StorageImpl.cpp`). */
import {throwTjsError} from '../../tjs2/runtime/errors.js';
import {TJS_E_BADPARAMCOUNT, TJS_S_OK} from '../../tjs2/runtime/interface.js';
import {NativeClass} from '../../tjs2/runtime/native.js';
import type {Suspender} from '../../tjs2/runtime/suspension.js';
import {asObject, asString, bool, str, type Variant} from '../../tjs2/runtime/variant.js';
import {
  chopStorageExt,
  extractStorageExt,
  extractStorageName,
  extractStoragePath,
  type StorageSystem,
} from '../storage.js';

/** Platform services `Storages` needs beyond the storage system. */
export interface StoragesPlatform {
  /** `TVPSearchCD`: the drive letter of a CD with the volume label, or the empty string. */
  searchCD(label: string): string;
  /**
   * `TVPSelectFile`: a modal file dialog described by the `params` dictionary, which receives
   * the chosen name. True when a file was chosen.
   */
  selectFile(params: Variant): boolean | Promise<boolean>;
}

export function createStoragesClass(
  storage: StorageSystem,
  platform: StoragesPlatform,
  suspender: Suspender,
): NativeClass {
  const cls = new NativeClass('Storages', () => throwTjsError('TVPCannotCreateInstance'));
  const pathFunction = (name: string, f: (path: string) => string) =>
    cls.staticMethod(name, (result, args) => {
      if (args.length < 1) return TJS_E_BADPARAMCOUNT;
      const path = asString(args[0]!);
      if (result) result.set(str(f(path)));
      return TJS_S_OK;
    });
  cls.emptyFinalize();
  cls.staticMethod('addAutoPath', (result, args) => {
    if (args.length < 1) return TJS_E_BADPARAMCOUNT;
    storage.addAutoPath(asString(args[0]!));
    result?.clear();
    return TJS_S_OK;
  });
  cls.staticMethod('removeAutoPath', (result, args) => {
    if (args.length < 1) return TJS_E_BADPARAMCOUNT;
    storage.removeAutoPath(asString(args[0]!));
    result?.clear();
    return TJS_S_OK;
  });
  pathFunction('getFullPath', (p) => storage.normalize(p));
  pathFunction('getPlacedPath', (p) => storage.getPlacedPath(p));
  cls.staticMethod('isExistentStorage', (result, args) => {
    if (args.length < 1) return TJS_E_BADPARAMCOUNT;
    const path = asString(args[0]!);
    if (result) result.set(bool(storage.isExistentStorage(path)));
    return TJS_S_OK;
  });
  pathFunction('extractStorageExt', extractStorageExt);
  pathFunction('extractStorageName', extractStorageName);
  pathFunction('extractStoragePath', extractStoragePath);
  pathFunction('chopStorageExt', chopStorageExt);
  cls.staticMethod('clearArchiveCache', () => {
    storage.clearArchiveCache();
    return TJS_S_OK;
  });
  // win32 members (TVPCreateNativeClass_Storages)
  cls.staticMethod('searchCD', (result, args) => {
    if (args.length < 1) return TJS_E_BADPARAMCOUNT;
    if (result) result.set(str(platform.searchCD(asString(args[0]!))));
    return TJS_S_OK;
  });
  cls.staticMethod('getLocalName', (result, args) => {
    if (args.length < 1) return TJS_E_BADPARAMCOUNT;
    if (result) result.set(str(storage.getLocalName(storage.normalize(asString(args[0]!)))));
    return TJS_S_OK;
  });
  cls.staticMethod('selectFile', (result, args) => {
    if (args.length < 1) return TJS_E_BADPARAMCOUNT;
    asObject(args[0]!);
    const chosen = platform.selectFile(args[0]!);
    const finish = (ok: boolean) => (result?.set(bool(ok)), TJS_S_OK);
    return chosen instanceof Promise ? suspender.suspend(chosen, finish) : finish(chosen);
  });
  return cls;
}

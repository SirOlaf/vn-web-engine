/**
 * PackinOne's `fstat` (wamsoft fstat as of 2014-05-08): file functions attached to `Storages`
 * (`StoragesFstat`) and the `TemporaryFiles` class. Local files go through `kernel32.dll`;
 * storages inside archives through the core's streams. Time stamps are `Date` objects made
 * with the script's `Date` class (`Date.setTime` / `Date.getTime`, milliseconds since 1970).
 */
import {md5Hex} from '../../core/md5.js';
import {
  ncbBool,
  ncbInt,
  ncbString,
  NcbClassInfo,
  type NcbAttachDefinition,
  type NcbClassDefinition,
  type NcbDisposable,
} from '../../engines/kirikiri/tp-stub/ncbind.js';
import {
  DictionaryBuilder,
  getLocallyAccessibleName,
} from '../../engines/kirikiri/tp-stub/tp-stub.js';
import {VariantSlot} from '../../engines/kirikiri/tjs2/runtime/slot.js';
import {
  asInteger,
  asObject,
  bool,
  int,
  integer,
  obj,
  str,
} from '../../engines/kirikiri/tjs2/runtime/variant.js';
import {
  FILE_FLAG_BACKUP_SEMANTICS,
  FORMAT_MESSAGE_FROM_SYSTEM,
  GENERIC_READ,
  GENERIC_WRITE,
  INVALID_HANDLE_VALUE,
  OPEN_EXISTING,
  READ_CONTROL,
  FILE_SHARE_DELETE,
  FILE_SHARE_READ,
  FILE_SHARE_WRITE,
  FILE_FLAG_DELETE_ON_CLOSE,
  type Kernel32Exports,
  type WindowsFileInfo,
} from '../kernel32/contract.js';
import {
  TJS_BS_READ,
  TJS_BS_SEEK_SET,
  TJS_BS_WRITE,
  TJS_E_BADPARAMCOUNT,
  TJS_S_OK,
  TJS_STATICMEMBER,
  type Dispatch,
  type ObjectVariant,
  type Out,
  type TjsBinaryStream,
  type TvpFunctionExporter,
  type Variant,
  type VariantResult,
} from '../tvp-plugin/contract.js';

const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_NORMAL = 0x80;
/** The attributes `setFileAttributes`/`resetFileAttributes` may change. */
const SETTABLE_ATTRIBUTES = 0x80 | 0x01 | 0x02 | 0x20 | 0x04 | 0x100;
const EPOCH_DIFFERENCE = 0x19db1ded53e8000n;
const SLASH_MESSAGE = "'/' must be specified at the end of given directory name.";

/** Executed after registration: the attribute constants as globals. */
export const FSTAT_PRE_SCRIPT =
  'global.FILE_ATTRIBUTE_READONLY = 0x00000001,global.FILE_ATTRIBUTE_HIDDEN = 0x00000002,' +
  'global.FILE_ATTRIBUTE_SYSTEM = 0x00000004,global.FILE_ATTRIBUTE_DIRECTORY = 0x00000010,' +
  'global.FILE_ATTRIBUTE_ARCHIVE = 0x00000020,global.FILE_ATTRIBUTE_NORMAL = 0x00000080,' +
  'global.FILE_ATTRIBUTE_TEMPORARY = 0x00000100;';

export interface FstatServices {
  readonly ex: TvpFunctionExporter;
  readonly kernel32: Kernel32Exports;
}

/** The `Date` class and its `setTime`/`getTime`, read after registration. */
export interface DateMembers {
  cls: Dispatch | null;
  setTime: Dispatch | null;
  getTime: Dispatch | null;
}

function evaluate(ex: TvpFunctionExporter, expression: string): Dispatch | null {
  const slot = new VariantSlot();
  ex.TVPExecuteExpression(expression, null, slot);
  const o = asObject(slot.value);
  o?.addRef();
  slot.clear();
  return o;
}

/** `PostRegistCallback`. */
export function fstatPostRegist(ex: TvpFunctionExporter, date: DateMembers): void {
  date.cls = evaluate(ex, 'Date');
  date.setTime = evaluate(ex, 'Date.setTime');
  date.getTime = evaluate(ex, 'Date.getTime');
  ex.TVPExecuteExpression(FSTAT_PRE_SCRIPT, null, null);
}

/** `PreUnregistCallback` (releases the class and `setTime`, as the native plugin does). */
export function fstatPreUnregist(date: DateMembers): void {
  date.cls?.release();
  date.cls = null;
  date.setTime?.release();
  date.setTime = null;
}

class Fstat {
  constructor(
    private readonly s: FstatServices,
    private readonly date: DateMembers,
  ) {}

  lastError(): string {
    const k = this.s.kernel32;
    return k.FormatMessageW(FORMAT_MESSAGE_FROM_SYSTEM, k.GetLastError(), 0x400) ?? '';
  }

  /** `storeDate`: a `Date` for a non-zero `FILETIME`, else void. */
  storeDate(ft: bigint): ObjectVariant | null {
    const {cls, setTime} = this.date;
    if (ft <= 0n || !cls || !setTime) return null;
    const out: Out<Dispatch | null> = {value: null};
    if (cls.createNew(0, null, out, [], null) < 0 || !out.value) return null;
    const unix = BigInt.asIntN(64, BigInt.asUintN(64, ft - EPOCH_DIFFERENCE) / 10000n);
    setTime.funcCall(0, null, null, [integer(unix)], out.value);
    return obj(out.value, out.value);
  }

  /** `restoreDate`. */
  restoreDate(v: Variant): bigint | null {
    if (v.type !== 1) return null;
    const date = asObject(v);
    const getTime = this.date.getTime;
    if (!date || !getTime) return null;
    const slot = new VariantSlot();
    try {
      if (getTime.funcCall(0, null, slot, [], date) !== TJS_S_OK) return null;
      return BigInt.asUintN(64, asInteger(slot.value) * 10000n + EPOCH_DIFFERENCE);
    } finally {
      slot.clear();
    }
  }

  /** `getLocalName`: the local name without a trailing backslash. */
  localName(path: string): string {
    const local = this.s.ex.TVPGetLocalName(path);
    return local.endsWith('\\') ? local.slice(0, -1) : local;
  }

  /** `_getFileHandle`. */
  fileHandle(filename: string, write: boolean): {handle: number; isDir: boolean} {
    const k = this.s.kernel32;
    const attr = k.GetFileAttributesW(filename) >>> 0;
    const isDir = attr !== 0xffffffff && (attr & FILE_ATTRIBUTE_DIRECTORY) !== 0;
    const handle = k.CreateFileW(
      filename,
      write ? GENERIC_WRITE : isDir ? READ_CONTROL : GENERIC_READ,
      FILE_SHARE_READ,
      OPEN_EXISTING,
      isDir ? FILE_FLAG_BACKUP_SEMANTICS : FILE_ATTRIBUTE_NORMAL,
    );
    return {handle, isDir};
  }

  /** `_getTime`: the size and time dictionary of a local file. */
  getTime(result: VariantResult | null, name: Variant, withSize: boolean): number {
    const s = this.s;
    const k = s.kernel32;
    const filename = this.localName(s.ex.TVPNormalizeStorageName(ncbString(name)));
    const {handle, isDir} = this.fileHandle(filename, false);
    if (handle !== INVALID_HANDLE_VALUE) {
      const size = !isDir && withSize ? k.GetFileSizeEx(handle) : null;
      const times = k.GetFileTime(handle);
      k.CloseHandle(handle);
      if (result) {
        const d = new DictionaryBuilder(s.ex);
        if (withSize && !isDir && size !== null) d.set('size', integer(size));
        for (const [key, ft] of [
          ['mtime', times?.write],
          ['ctime', times?.creation],
          ['atime', times?.access],
        ] as const) {
          const v = ft !== undefined ? this.storeDate(ft) : null;
          if (v) {
            d.set(key, v);
            v.object?.release();
          } else d.set(key, {type: 0});
        }
        d.toResult(result);
      }
      return TJS_S_OK;
    }
    return s.ex.TVPThrowExceptionMessage('cannot open : ' + ncbString(name));
  }

  dirlist(dir: string, withInfo: boolean, result: VariantResult | null): void {
    const s = this.s;
    let d = s.ex.TVPNormalizeStorageName(dir);
    if (!d.endsWith('/')) s.ex.TVPThrowExceptionMessage(SLASH_MESSAGE);
    d = s.ex.TVPGetLocalName(d);
    const array = s.ex.TJSCreateArrayObject();
    try {
      const entries = s.kernel32.FindFiles(d + '*.*');
      if (!entries) return s.ex.TVPThrowExceptionMessage('Directory not found.');
      entries.forEach((e: WindowsFileInfo, i: number) => {
        if (!withInfo) {
          const name = e.attributes & FILE_ATTRIBUTE_DIRECTORY ? e.name + '/' : e.name;
          array.propSetByNum(0, i, str(name), array);
          return;
        }
        const info = new DictionaryBuilder(s.ex)
          .set('name', e.name)
          .set('size', integer(e.size))
          .set('attrib', int(e.attributes | 0));
        for (const [key, ft] of [
          ['mtime', e.writeTime],
          ['ctime', e.creationTime],
          ['atime', e.accessTime],
        ] as const) {
          const v = this.storeDate(ft);
          info.set(key, v ?? {type: 0});
          v?.object?.release();
        }
        const slot = new VariantSlot();
        info.toResult(slot);
        array.propSetByNum(0, i, slot.value, array);
        slot.clear();
      });
      result?.set(obj(array, array));
    } finally {
      array.release();
    }
  }

  checkDirectoryName(dir: string): void {
    if (!dir.endsWith('/')) this.s.ex.TVPThrowExceptionMessage(SLASH_MESSAGE);
  }
}

/** Reads a whole storage (`TVPCreateIStream` + `Read`), then calls `then`. */
function readStorage(
  ex: TvpFunctionExporter,
  name: string,
  then: (bytes: Uint8Array) => number,
): number {
  const opened = ex.TVPCreateStream(name, TJS_BS_READ);
  const read = async (stream: TjsBinaryStream) => {
    const size = stream.getSize();
    await stream.prefetch(0, size);
    stream.seek(0, TJS_BS_SEEK_SET);
    const bytes = stream.read(size);
    stream.destruct();
    return bytes;
  };
  return ex.suspend(Promise.resolve(opened).then(read), then);
}

export const STORAGES_FSTAT = new NcbClassInfo<Fstat>('StoragesFstat');
export const TEMPORARY_FILES = new NcbClassInfo<TemporaryFiles>('TemporaryFiles');

/** `NCB_ATTACH_CLASS(StoragesFstat, Storages)`. */
export function storagesFstat(s: FstatServices, date: DateMembers): NcbAttachDefinition<Fstat> {
  const ex = s.ex;
  const k = s.kernel32;
  const f = new Fstat(s, date);
  const local = (name: string) => getLocallyAccessibleName(ex, name);
  return {
    info: STORAGES_FSTAT,
    tjs2Class: 'Storages',
    define: (r) => {
      r.staticMethod('clearStorageCaches', 0, () => ex.TVPClearStorageCaches())
        .rawCallback(
          'fstat',
          (result, args) => {
            if (args.length < 1) return TJS_E_BADPARAMCOUNT;
            const filename = ex.TVPGetPlacedPath(ncbString(args[0]!));
            if (filename.length > 0 && !local(filename)) {
              // A storage in an archive: only its size.
              return readStorage(ex, filename, (bytes) => {
                new DictionaryBuilder(ex)
                  .set('size', integer(BigInt(bytes.length)))
                  .toResult(result);
                return TJS_S_OK;
              });
            }
            return f.getTime(result, args[0]!, true);
          },
          TJS_STATICMEMBER,
        )
        .rawCallback(
          'getTime',
          (result, args) =>
            args.length < 1 ? TJS_E_BADPARAMCOUNT : f.getTime(result, args[0]!, false),
          TJS_STATICMEMBER,
        )
        .rawCallback(
          'setTime',
          (result, args) => {
            if (args.length < 2) return TJS_E_BADPARAMCOUNT;
            const filename = f.localName(ex.TVPNormalizeStorageName(ncbString(args[0]!)));
            const times: Variant[] = [{type: 0}, {type: 0}, {type: 0}];
            const dict = asObject(args[1]!);
            const slots = times.map(() => new VariantSlot());
            if (dict)
              ['ctime', 'atime', 'mtime'].forEach((key, i) =>
                dict.propGet(0, key, slots[i]!, dict),
              );
            const [c, a, m] = slots.map((sl) => f.restoreDate(sl.value));
            slots.forEach((sl) => sl.clear());
            const {handle} = f.fileHandle(filename, true);
            let ok = false;
            if (handle !== INVALID_HANDLE_VALUE) {
              ok = k.SetFileTime(handle, c ?? null, a ?? null, m ?? null);
              if (!ok) ex.TVPAddLog(`setFileTime : ${filename}:${f.lastError()}`);
              k.CloseHandle(handle);
            }
            result?.set(bool(ok));
            return TJS_S_OK;
          },
          TJS_STATICMEMBER,
        )
        .staticMethod('getLastModifiedFileTime', 1, (args) => {
          const filename = f.localName(ex.TVPNormalizeStorageName(ncbString(args[0]!)));
          const {handle} = f.fileHandle(filename, false);
          if (handle === INVALID_HANDLE_VALUE) return integer(0n);
          const t = k.GetFileTime(handle);
          k.CloseHandle(handle);
          // tjs_uint64 through NCB_TYPECONV_CAST_INTEGER: the signed 64-bit integer.
          return integer(t ? BigInt.asIntN(64, t.write) : 0n);
        })
        .staticMethod('setLastModifiedFileTime', 2, (args) => {
          const filename = f.localName(ex.TVPNormalizeStorageName(ncbString(args[0]!)));
          const {handle} = f.fileHandle(filename, true);
          if (handle === INVALID_HANDLE_VALUE) return bool(false);
          const ok = k.SetFileTime(handle, null, null, BigInt.asUintN(64, asInteger(args[1]!)));
          k.CloseHandle(handle);
          return bool(ok);
        })
        .rawCallback(
          'exportFile',
          (_result, args) => {
            if (args.length < 2) return TJS_E_BADPARAMCOUNT;
            const filename = ncbString(args[0]!);
            const storename = ncbString(args[1]!);
            return readStorage(ex, filename, (bytes) => {
              const out = ex.TVPCreateStream(storename, TJS_BS_WRITE);
              if (out instanceof Promise)
                return ex.TVPThrowExceptionMessage('cannot open storefile: ' + storename);
              out.write(bytes);
              out.destruct();
              return TJS_S_OK;
            });
          },
          TJS_STATICMEMBER,
        )
        .staticMethod('deleteFile', 1, (args) => {
          const filename = local(ex.TVPGetPlacedPath(ncbString(args[0]!)));
          let ok = false;
          if (filename) {
            ok = k.DeleteFileW(filename);
            if (!ok) ex.TVPAddLog(`deleteFile : ${filename} : ${f.lastError()}`);
            else ex.TVPClearStorageCaches();
          }
          return bool(ok);
        })
        .staticMethod('truncateFile', 2, (args) => {
          const filename = local(ex.TVPGetPlacedPath(ncbString(args[0]!)));
          let ok = false;
          if (filename) {
            const {handle} = f.fileHandle(filename, true);
            if (handle !== INVALID_HANDLE_VALUE) {
              ok = k.SetEndOfFileAt(handle, BigInt(ncbInt(args[1]!)));
              if (!ok) ex.TVPAddLog(`truncateFile : ${filename} : ${f.lastError()}`);
              k.CloseHandle(handle);
            }
          }
          return bool(ok);
        })
        .staticMethod('moveFile', 2, (args) => {
          const from = local(ncbString(args[0]!));
          const to = local(ncbString(args[1]!));
          let ok = false;
          if (from && to) {
            ok = k.MoveFileW(from, to);
            if (!ok) ex.TVPAddLog(`moveFile : ${from}, ${to} : ${f.lastError()}`);
            else ex.TVPClearStorageCaches();
          }
          return bool(ok);
        })
        .staticMethod('dirlist', 1, (args, _o, result) =>
          f.dirlist(ncbString(args[0]!), false, result),
        )
        .staticMethod('dirlistEx', 1, (args, _o, result) =>
          f.dirlist(ncbString(args[0]!), true, result),
        )
        .staticMethod('removeDirectory', 1, (args) => {
          const dir = ncbString(args[0]!);
          f.checkDirectoryName(dir);
          const path = ex.TVPGetLocalName(ex.TVPNormalizeStorageName(dir));
          const ok = k.RemoveDirectoryW(path);
          if (!ok) ex.TVPAddLog(`removeDirectory : ${path} : ${f.lastError()}`);
          return bool(ok);
        })
        .staticMethod('createDirectory', 1, (args) => {
          const dir = ncbString(args[0]!);
          f.checkDirectoryName(dir);
          const path = ex.TVPGetLocalName(ex.TVPNormalizeStorageName(dir));
          const ok = k.CreateDirectoryW(path);
          if (!ok) ex.TVPAddLog(`createDirectory : ${path} : ${f.lastError()}`);
          return bool(ok);
        })
        .staticMethod('changeDirectory', 1, (args) => {
          const dir = ncbString(args[0]!);
          f.checkDirectoryName(dir);
          const path = ex.TVPGetLocalName(ex.TVPNormalizeStorageName(dir));
          const ok = k.SetCurrentDirectoryW(path);
          if (!ok) ex.TVPAddLog(`changeDirectory : ${path} : ${f.lastError()}`);
          return bool(ok);
        })
        .staticMethod('setFileAttributes', 2, (args) => {
          const name = ex.TVPGetLocalName(ex.TVPNormalizeStorageName(ncbString(args[0]!)));
          const attr =
            (Number(BigInt.asUintN(32, asInteger(args[1]!))) & SETTABLE_ATTRIBUTES) >>> 0;
          const org = k.GetFileAttributesW(name);
          return bool(k.SetFileAttributesW(name, (org | attr) >>> 0));
        })
        .staticMethod('resetFileAttributes', 2, (args) => {
          const name = ex.TVPGetLocalName(ex.TVPNormalizeStorageName(ncbString(args[0]!)));
          const attr =
            (Number(BigInt.asUintN(32, asInteger(args[1]!))) & SETTABLE_ATTRIBUTES) >>> 0;
          const org = k.GetFileAttributesW(name);
          return bool(k.SetFileAttributesW(name, (org & ~attr) >>> 0));
        })
        .staticMethod('getFileAttributes', 1, (args) => {
          const name = ex.TVPGetLocalName(ex.TVPNormalizeStorageName(ncbString(args[0]!)));
          // DWORD through ncbind: the unsigned value.
          return integer(BigInt(k.GetFileAttributesW(name) >>> 0));
        })
        .rawCallback(
          'selectDirectory',
          (result, args) => {
            if (args.length < 1) return TJS_E_BADPARAMCOUNT;
            // SHBrowseForFolder: the shell's folder browser is not available; the dialog is
            // reported as cancelled.
            result?.set(int(0));
            return TJS_S_OK;
          },
          TJS_STATICMEMBER,
        )
        .staticMethod('isExistentDirectory', 1, (args) => {
          const dir = ncbString(args[0]!);
          f.checkDirectoryName(dir);
          const path = ex.TVPGetLocalName(ex.TVPNormalizeStorageName(dir));
          const attr = k.GetFileAttributesW(path) >>> 0;
          return bool(attr !== 0xffffffff && (attr & FILE_ATTRIBUTE_DIRECTORY) !== 0);
        })
        .staticMethod('copyFile', 3, (args) => {
          const from = local(ex.TVPGetPlacedPath(ncbString(args[0]!)));
          const to = local(ex.TVPNormalizeStorageName(ncbString(args[1]!)));
          return bool(copy(from, to, ncbBool(args[2]!)));
        })
        .staticMethod('copyFileNoNormalize', 3, (args) => {
          const from = local(ex.TVPGetPlacedPath(ncbString(args[0]!)));
          const to = ncbString(args[1]!);
          if (!to) return bool(false);
          return bool(copy(from, ex.TVPGetLocalName(to), ncbBool(args[2]!)));
        })
        .staticMethod('isExistentStorageNoSearchNoNormalize', 1, (args) =>
          bool(ex.TVPIsExistentStorageNoSearchNoNormalize(ncbString(args[0]!))),
        )
        .staticMethod('getDisplayName', 1, (args) => {
          // SHGetFileInfo(SHGFI_DISPLAYNAME): the shell shows the name with its extension.
          const name = ex.TVPGetLocalName(ex.TVPNormalizeStorageName(ncbString(args[0]!)));
          if (!name) return str(name);
          if (k.GetFileAttributesW(name) >>> 0 === 0xffffffff)
            ex.TVPThrowExceptionMessage('SHGetFileInfo failed');
          return str(name.slice(name.lastIndexOf('\\') + 1));
        })
        .rawCallback(
          'getMD5HashString',
          (result, args) => {
            if (args.length < 1) return TJS_E_BADPARAMCOUNT;
            const filename = ex.TVPGetPlacedPath(ncbString(args[0]!));
            return readStorage(ex, filename, (bytes) => {
              result?.set(str(md5Hex(bytes)));
              return TJS_S_OK;
            });
          },
          TJS_STATICMEMBER,
        )
        .rawCallback(
          'searchPath',
          (result, args) => {
            if (args.length < 1) return TJS_E_BADPARAMCOUNT;
            const path = args.length > 1 && args[1]!.type !== 0 ? ncbString(args[1]!) : '';
            const found = k.SearchPathW(path || null, ncbString(args[0]!));
            if (found !== null) result?.set(str(ex.TVPNormalizeStorageName(found)));
            else result?.clear();
            return TJS_S_OK;
          },
          TJS_STATICMEMBER,
        )
        .staticProperty(
          'currentPath',
          () => str(ex.TVPNormalizeStorageName(k.GetCurrentDirectoryW() + '\\')),
          (v) => {
            const path = ncbString(v);
            f.checkDirectoryName(path);
            const ok = k.SetCurrentDirectoryW(ex.TVPGetLocalName(ex.TVPNormalizeStorageName(path)));
            if (!ok) ex.TVPThrowExceptionMessage('setCurrentPath failed:%1', f.lastError());
          },
        )
        .staticMethod('getTemporaryName', 0, () => str(ex.TVPGetTemporaryName()));
    },
  };

  function copy(from: string, to: string, failIfExists: boolean): boolean {
    if (from && to && k.CopyFileW(from, to, failIfExists)) {
      ex.TVPClearStorageCaches();
      return true;
    }
    return false;
  }
}

/** `TemporaryFiles`: files and folders deleted when the object goes. */
class TemporaryFiles implements NcbDisposable {
  readonly handles: number[] = [];
  constructor(private readonly s: FstatServices) {}
  entry(name: string, folder: boolean): boolean {
    const ex = this.s.ex;
    const filename = ex.TVPGetLocalName(ex.TVPNormalizeStorageName(name));
    if (!filename) return false;
    const h = this.s.kernel32.CreateFileW(
      filename,
      0,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      OPEN_EXISTING,
      folder
        ? FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_DELETE_ON_CLOSE
        : FILE_ATTRIBUTE_NORMAL | FILE_FLAG_DELETE_ON_CLOSE,
    );
    if (h === INVALID_HANDLE_VALUE) return false;
    this.handles.push(h);
    return true;
  }
  /**
   * Closes the handles, deleting the entries. (The native destructor never advances its
   * iterator and so never returns once an entry was made.)
   */
  dispose(): void {
    for (const h of this.handles.splice(0)) this.s.kernel32.CloseHandle(h);
  }
}

/** `NCB_REGISTER_CLASS(TemporaryFiles)`. */
export function temporaryFiles(s: FstatServices): NcbClassDefinition<TemporaryFiles> {
  return {
    info: TEMPORARY_FILES,
    define: (r) =>
      r
        .constructor_(0, () => new TemporaryFiles(s))
        .method('entry', 1, (t, args) => bool(t.entry(ncbString(args[0]!), false)))
        .method('entryFolder', 1, (t, args) => bool(t.entry(ncbString(args[0]!), true))),
  };
}

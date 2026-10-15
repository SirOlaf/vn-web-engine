/**
 * PackinOne's `addFont` (wamsoft addFont as of 2014-05-08): `System.addFont(storage,
 * extract)` registers a private font with GDI — a local file directly, a storage in an archive
 * either from memory or (`extract`) through a temporary file. The result is the number of fonts
 * added; void when the storage cannot be found. Fonts are removed when the plugin unlinks.
 */
import {
  NcbClassInfo,
  ncbInt,
  ncbString,
  type NcbAttachDefinition,
} from '../../engines/kirikiri/tp-stub/ncbind.js';
import {getLocallyAccessibleName} from '../../engines/kirikiri/tp-stub/tp-stub.js';
import {int} from '../../engines/kirikiri/tjs2/runtime/variant.js';
import type {Gdi32Exports} from '../gdi32/contract.js';
import {
  CREATE_ALWAYS,
  GENERIC_READ,
  GENERIC_WRITE,
  INVALID_HANDLE_VALUE,
  OPEN_EXISTING,
  type Kernel32Exports,
} from '../kernel32/contract.js';
import {
  TJS_BS_READ,
  TJS_BS_SEEK_SET,
  TJS_E_BADPARAMCOUNT,
  TJS_S_OK,
  TJS_STATICMEMBER,
  type TjsBinaryStream,
  type TvpFunctionExporter,
} from '../tvp-plugin/contract.js';

const FILE_ATTRIBUTE_TEMPORARY = 0x100;

export interface AddFontServices {
  readonly ex: TvpFunctionExporter;
  readonly kernel32: Kernel32Exports;
  readonly gdi32: Gdi32Exports;
}

/** Registered fonts, removed by `PostUnregistCallback`. */
export class FontList {
  readonly files: string[] = [];
  readonly tempFiles: string[] = [];
  readonly memory: number[] = [];
}

function readFile(k: Kernel32Exports, path: string): Uint8Array | null {
  const h = k.CreateFileW(path, GENERIC_READ, 1, OPEN_EXISTING, 0x80);
  if (h === INVALID_HANDLE_VALUE) return null;
  const size = Number(k.GetFileSizeEx(h) ?? 0n);
  const data = k.ReadFile(h, size);
  k.CloseHandle(h);
  return data;
}

export const FONT_EX = new NcbClassInfo<object>('FontEx');

export function fontEx(s: AddFontServices, list: FontList): NcbAttachDefinition<object> {
  const {ex, kernel32: k, gdi32: g} = s;
  return {
    info: FONT_EX,
    tjs2Class: 'System',
    define: (r) =>
      r.rawCallback(
        'addFont',
        (result, args) => {
          if (args.length < 1) return TJS_E_BADPARAMCOUNT;
          const filename = ex.TVPGetPlacedPath(ncbString(args[0]!));
          if (!filename) return TJS_S_OK;
          const local = getLocallyAccessibleName(ex, filename);
          if (local) {
            const data = readFile(k, local);
            const ret = data ? g.AddFontResourceExW(local, data) : 0;
            if (ret > 0) list.files.push(local);
            result?.set(int(ret));
            return TJS_S_OK;
          }
          const extract = args.length > 1 && ncbInt(args[1]!) !== 0;
          const opened = ex.TVPCreateStream(filename, TJS_BS_READ);
          const read = async (stream: TjsBinaryStream) => {
            const size = stream.getSize();
            await stream.prefetch(0, size);
            stream.seek(0, TJS_BS_SEEK_SET);
            const bytes = stream.read(size);
            stream.destruct();
            return bytes;
          };
          return ex.suspend(Promise.resolve(opened).then(read), (data) => {
            if (extract) {
              const temp = ex.TVPGetTemporaryName();
              const h = k.CreateFileW(
                temp,
                GENERIC_WRITE,
                0,
                CREATE_ALWAYS,
                FILE_ATTRIBUTE_TEMPORARY,
              );
              if (h === INVALID_HANDLE_VALUE) return TJS_S_OK;
              k.WriteFile(h, data);
              k.CloseHandle(h);
              const ret = g.AddFontResourceExW(temp, data);
              if (ret > 0) list.tempFiles.push(temp);
              else k.DeleteFileW(temp);
              result?.set(int(ret));
            } else {
              const {handle, count} = g.AddFontMemResourceEx(data);
              if (handle) list.memory.push(handle);
              result?.set(int(count));
            }
            return TJS_S_OK;
          });
        },
        TJS_STATICMEMBER,
      ),
  };
}

/** `PostUnregistCallback`. */
export function addFontPostUnregist(s: AddFontServices, list: FontList): void {
  for (const f of list.files.splice(0)) s.gdi32.RemoveFontResourceExW(f);
  for (const f of list.tempFiles.splice(0)) {
    s.gdi32.RemoveFontResourceExW(f);
    s.kernel32.DeleteFileW(f);
  }
  for (const h of list.memory.splice(0)) s.gdi32.RemoveFontMemResourceEx(h);
}

/**
 * PackinOne's `systemEx` (wamsoft systemEx as of 2014-02-25): functions attached to `System`:
 * `writeRegValue`, environment variables, `urlencode`/`urldecode`, `getAboutString`, a yes/no
 * `confirm` box and `waitForAppLock`.
 *
 * As natively: the registry root is chosen by fixed character positions of the upper-cased
 * first path element (`HKEY_CURRENT_USER` by default, short names such as `HKCU` included);
 * string values are written with an odd byte count (`length * 2 + 1`); `urlencode` keeps
 * `A–Z a–z 0–9 - _ . ~` and percent-encodes other bytes of the UTF-8 (default) or ANSI form;
 * `urldecode` fails with `TJS_E_INVALIDPARAM` on characters above U+00FF or a `%` without two
 * following characters.
 */
import {ncbInt, ncbString} from '../../engines/kirikiri/tp-stub/ncbind.js';
import {VariantSlot} from '../../engines/kirikiri/tjs2/runtime/slot.js';
import {asObject, bool, str} from '../../engines/kirikiri/tjs2/runtime/variant.js';
import {
  HKEY_CLASSES_ROOT,
  HKEY_CURRENT_CONFIG,
  HKEY_CURRENT_USER,
  HKEY_DYN_DATA,
  HKEY_LOCAL_MACHINE,
  HKEY_PERFORMANCE_DATA,
  HKEY_USERS,
  REG_DWORD,
  REG_SZ,
  type Advapi32Exports,
} from '../advapi32/contract.js';
import {
  CP_ACP,
  WAIT_ABANDONED,
  WAIT_OBJECT_0,
  WAIT_TIMEOUT,
  type Kernel32Exports,
} from '../kernel32/contract.js';
import {
  TJS_E_BADPARAMCOUNT,
  TJS_E_FAIL,
  TJS_E_INVALIDPARAM,
  TJS_S_OK,
  TJS_S_TRUE,
  TJS_STATICMEMBER,
  type Dispatch,
  type TvpFunctionExporter,
  type Variant,
  type VariantResult,
} from '../tvp-plugin/contract.js';
import type {User32Exports} from '../user32/contract.js';

const HEX = '0123456789ABCDEF';
const MB_YESNO = 4;
const IDYES = 6;

export interface SystemExServices {
  readonly ex: TvpFunctionExporter;
  readonly kernel32: Kernel32Exports;
  readonly user32: User32Exports;
  readonly advapi32: () => Advapi32Exports;
}

/** The root key `writeRegValue` picks from the upper-cased first path element. */
function rootKey(hkey: string): number {
  const at = (i: number) => hkey[i] ?? '\0';
  if (at(5) === 'C') {
    if (at(6) === 'L') return HKEY_CLASSES_ROOT;
    if (at(13) === 'C') return HKEY_CURRENT_CONFIG;
    return HKEY_CURRENT_USER;
  }
  if (at(5) === 'L') return HKEY_LOCAL_MACHINE;
  if (at(5) === 'U') return HKEY_USERS;
  if (at(5) === 'P') return HKEY_PERFORMANCE_DATA;
  if (at(5) === 'D') return HKEY_DYN_DATA;
  return HKEY_CURRENT_USER;
}

/** `strtol(buf, NULL, 16)` of two characters: the leading hexadecimal digits. */
function hex2(s: string): number {
  const m = /^[ \t\n\v\f\r]*([+-]?)(?:0[xX])?([0-9a-fA-F]*)/.exec(s);
  if (!m || !m[2]) return 0;
  const v = parseInt(m[2], 16);
  return m[1] === '-' ? -v : v;
}

/** A raw function (`tTJSNativeClassMethodCallback`). */
export type RawFunction = (
  result: VariantResult | null,
  args: readonly Variant[],
  objthis: Dispatch,
) => number;

/** The `NCB_ATTACH_FUNCTION`s on `System`, in registration order. */
export function systemExFunctions(s: SystemExServices): [string, RawFunction][] {
  const {ex, kernel32: k, user32: u} = s;
  const list: [string, RawFunction][] = [];
  const r = {
    rawCallback(name: string, body: RawFunction, _flags: number) {
      list.push([name, body]);
      return r;
    },
    staticMethod(name: string, _min: number, body: () => Variant) {
      list.push([
        name,
        (result) => {
          result?.set(body());
          return TJS_S_OK;
        },
      ]);
      return r;
    },
  };
  r.rawCallback(
    'writeRegValue',
    (_result, args) => {
      if (args.length < 2) return TJS_E_BADPARAMCOUNT;
      const key = ncbString(args[0]!);
      let i = key.indexOf('\\');
      if (i < 0) i = key.length;
      const root = rootKey(key.slice(0, i).toUpperCase());
      let j = key.lastIndexOf('\\');
      const keyname = key.slice(i + 1, Math.max(i + 1, j));
      if (j < 0) j = -1;
      const valname = key.slice(j + 1);
      const value = args[1]!;
      const advapi32 = s.advapi32();
      return ex.suspend(advapi32.RegCreateKeyExW(root, keyname), (created) => {
        if (created.result !== 0) return TJS_E_FAIL;
        let data: Uint8Array | null = null;
        let type = 0;
        if (value.type === 2) {
          const text = value.value;
          // `(DWORD)value.length()*2+1` bytes from the string's characters.
          data = new Uint8Array(text.length * 2 + 1);
          for (let n = 0; n < text.length; n++) {
            data[n * 2] = text.charCodeAt(n) & 0xff;
            if (n * 2 + 1 < data.length) data[n * 2 + 1] = text.charCodeAt(n) >>> 8;
          }
          type = REG_SZ;
        } else if (value.type === 4) {
          const v = Number(BigInt.asUintN(32, value.value));
          data = new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24]);
          type = REG_DWORD;
        }
        if (!data) {
          advapi32.RegCloseKey(created.key);
          return TJS_S_OK;
        }
        return ex.suspend(advapi32.RegSetValueExW(created.key, valname, type, data), () => {
          advapi32.RegCloseKey(created.key);
          return TJS_S_OK;
        });
      });
    },
    TJS_STATICMEMBER,
  )
    .rawCallback(
      'readEnvValue',
      (result, args) => {
        if (args.length < 1) return TJS_E_BADPARAMCOUNT;
        if (args[0]!.type !== 2) return TJS_E_INVALIDPARAM;
        const name = args[0]!.value;
        if (name === '') return TJS_E_INVALIDPARAM;
        if (result) {
          result.clear();
          const v = k.GetEnvironmentVariableW(name);
          if (v !== null) result.set(str(v));
        }
        return TJS_S_OK;
      },
      TJS_STATICMEMBER,
    )
    .rawCallback(
      'writeEnvValue',
      (result, args) => {
        if (args.length < 2) return TJS_E_BADPARAMCOUNT;
        if (args[0]!.type !== 2) return TJS_E_INVALIDPARAM;
        const name = args[0]!.value;
        if (name === '') return TJS_E_INVALIDPARAM;
        const value = ncbString(args[1]!);
        if (result) {
          result.clear();
          result.set(str(k.GetEnvironmentVariableW(name) ?? ''));
        }
        k.SetEnvironmentVariableW(name, value);
        return TJS_S_OK;
      },
      TJS_STATICMEMBER,
    )
    .rawCallback(
      'expandEnvString',
      (result, args) => {
        if (args.length < 1) return TJS_E_BADPARAMCOUNT;
        if (result) {
          result.clear();
          result.set(str(k.ExpandEnvironmentStringsW(ncbString(args[0]!))));
        }
        return TJS_S_OK;
      },
      TJS_STATICMEMBER,
    )
    .rawCallback(
      'urlencode',
      (result, args) => {
        if (args.length > 0 && result) {
          const utf8 = !(args.length > 1 && ncbInt(args[1]!) === 0);
          const text = ncbString(args[0]!);
          const bytes = utf8
            ? new TextEncoder().encode(text)
            : (k.WideCharToMultiByte(CP_ACP, text) ?? new Uint8Array(0));
          let os = '';
          for (const c of bytes) {
            const ch = String.fromCharCode(c);
            if (/[A-Za-z0-9\-_.~]/.test(ch)) os += ch;
            else os += '%' + HEX[(c >> 4) & 0x0f] + HEX[c & 0x0f];
          }
          result.set(str(os));
        }
        return TJS_S_OK;
      },
      TJS_STATICMEMBER,
    )
    .rawCallback(
      'urldecode',
      (result, args) => {
        if (args.length > 0 && result) {
          const utf8 = !(args.length > 1 && ncbInt(args[1]!) === 0);
          const text = ncbString(args[0]!);
          const os: number[] = [];
          for (let i = 0; i < text.length; i++) {
            const ch = text.charCodeAt(i);
            if (ch > 0xff) return TJS_E_INVALIDPARAM;
            if (ch === 0x25) {
              if (i + 2 >= text.length) return TJS_E_INVALIDPARAM;
              os.push(hex2(text.slice(i + 1, i + 3)) & 0xff);
              i += 2;
            } else os.push(ch);
          }
          // The bytes end at the first NUL (they pass through a C string).
          const nul = os.indexOf(0);
          const bytes = Uint8Array.from(nul >= 0 ? os.slice(0, nul) : os);
          if (utf8) {
            if (bytes.length > 0) result.set(str(new TextDecoder('utf-8').decode(bytes)));
          } else result.set(str(k.MultiByteToWideChar(CP_ACP, bytes) ?? ''));
        }
        return TJS_S_OK;
      },
      TJS_STATICMEMBER,
    )
    .staticMethod('getAboutString', 0, () => str(ex.TVPGetAboutString()))
    .rawCallback(
      'confirm',
      (result, args) => {
        if (args.length < 1) return TJS_E_BADPARAMCOUNT;
        const message = ncbString(args[0]!);
        let caption = '';
        let parent = ex.TVPGetApplicationWindowHandle();
        if (args.length > 2) {
          const window = asObject(args[2]!);
          if (!window || window.isInstanceOf(0, null, 'Window', window) !== TJS_S_TRUE)
            return ex.TVPThrowExceptionMessage('InvalidObject');
          const hwnd = new VariantSlot();
          window.propGet(0, 'HWND', hwnd, window);
          parent = ncbInt(hwnd.value);
          hwnd.clear();
        }
        if (args.length > 1) caption = ncbString(args[1]!);
        return ex.suspend(u.MessageBoxW(parent, message, caption, MB_YESNO), (ret) => {
          result?.set(bool(ret === IDYES));
          return TJS_S_OK;
        });
      },
      TJS_STATICMEMBER,
    )
    .rawCallback(
      'waitForAppLock',
      (result, args) => {
        if (args.length < 1) return TJS_E_BADPARAMCOUNT;
        const timeout = args.length >= 2 ? ncbInt(args[1]!) >>> 0 : 0;
        const key = ncbString(args[0]!);
        let status = 0;
        const mutex = k.OpenMutexW(key);
        if (mutex) {
          const w = k.WaitForSingleObject(mutex, timeout);
          k.CloseHandle(mutex);
          status = w === WAIT_ABANDONED || w === WAIT_OBJECT_0 ? 0 : w === WAIT_TIMEOUT ? 1 : -1;
        }
        if (result) {
          if (status < 0) result.clear();
          else result.set(bool(!status));
        }
        return TJS_S_OK;
      },
      TJS_STATICMEMBER,
    );
  return list;
}

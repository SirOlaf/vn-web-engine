import type {NativeLibraryImplementation} from '../../platform/native-libraries.js';
import {decodeCp932, encodeCp932} from '../../text/cp932.js';
import type {PageWindowsNamedMutexes} from '../../platform/windows-named-mutex.js';
import {
  ERROR_ACCESS_DENIED,
  ERROR_FILE_EXISTS,
  ERROR_FILE_NOT_FOUND,
  ERROR_PATH_NOT_FOUND,
  FILE_ATTRIBUTE_DIRECTORY,
  INVALID_FILE_ATTRIBUTES,
  NO_LOCAL_FILES,
  type WindowsFileInfo,
  type WindowsLocalFiles,
} from '../../platform/windows-local-files.js';
import {
  WAIT_FAILED,
  WAIT_OBJECT_0,
  CP_ACP,
  CP_UTF8,
  CREATE_ALWAYS,
  CREATE_NEW,
  ERROR_INVALID_PARAMETER,
  ERROR_MR_MID_NOT_FOUND,
  FILE_FLAG_BACKUP_SEMANTICS,
  FILE_FLAG_DELETE_ON_CLOSE,
  GENERIC_WRITE,
  INVALID_HANDLE_VALUE,
  OPEN_ALWAYS,
  FORMAT_MESSAGE_FROM_SYSTEM,
  FORMAT_MESSAGE_FROM_HMODULE,
  FORMAT_MESSAGE_FROM_STRING,
  KERNEL32,
  type Kernel32Exports,
} from './contract.js';

/**
 * System message texts (`FormatMessageW` from the system table) of the error codes the
 * reimplemented libraries set, in the languages of the supported systems.
 */
const SYSTEM_MESSAGES: ReadonlyMap<number, {readonly ja: string; readonly en: string}> = new Map([
  [0, {ja: 'この操作を正しく終了しました。', en: 'The operation completed successfully.'}],
  [
    2,
    {ja: '指定されたファイルが見つかりません。', en: 'The system cannot find the file specified.'},
  ],
  [87, {ja: 'パラメーターが間違っています。', en: 'The parameter is incorrect.'}],
  [
    126,
    {ja: '指定されたモジュールが見つかりません。', en: 'The specified module could not be found.'},
  ],
  [1400, {ja: 'ウィンドウ ハンドルが無効です。', en: 'Invalid window handle.'}],
  [1407, {ja: 'ウィンドウ クラスが見つかりません。', en: 'Cannot find window class.'}],
  [1410, {ja: 'クラスは既に存在します。', en: 'Class already exists.'}],
  [1413, {ja: 'インデックスが無効です。', en: 'Invalid index.'}],
  [1421, {ja: 'コントロール ID が見つかりません。', en: 'Control ID not found.'}],
  [
    1813,
    {
      ja: '指定されたリソースの種類がイメージ ファイルに見つかりません。',
      en: 'The specified resource type cannot be found in the image file.',
    },
  ],
  [
    1814,
    {
      ja: '指定されたリソース名がイメージ ファイルに見つかりません。',
      en: 'The specified resource name cannot be found in the image file.',
    },
  ],
]);

const LANG_JAPANESE = 0x11;
/** The ANSI code page of the supported systems (Japanese Windows). */
const ANSI_CODE_PAGE = 932;
const ERROR_INVALID_HANDLE = 6;

/** `c:/a/../b` → `c:\b`: separators, `.` and `..`, relative names against `cwd`. */
export function fullPathName(path: string, cwd: string): string {
  let p = path.replace(/\//g, '\\');
  if (!/^[a-z]:\\/i.test(p) && !p.startsWith('\\\\')) {
    if (p.startsWith('\\')) p = cwd.slice(0, 2) + p;
    else if (/^[a-z]:/i.test(p)) p = p.slice(0, 2) + '\\' + p.slice(2);
    else p = cwd.replace(/\\$/, '') + '\\' + p;
  }
  const unc = p.startsWith('\\\\');
  const parts = p.slice(unc ? 2 : 0).split('\\');
  const root = unc ? parts.shift()! + '\\' + (parts.shift() ?? '') : parts.shift()!;
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  const trailing = /\\$/.test(p) && out.length > 0 ? '\\' : '';
  return (unc ? '\\\\' : '') + root + '\\' + out.join('\\') + trailing;
}

/** Win32 wildcard match (`*`, `?`; `*.*` matches every name), case-insensitive. */
function wildcardMatch(pattern: string, name: string): boolean {
  if (pattern === '*.*' || pattern === '*') return true;
  const re = new RegExp(
    '^' +
      pattern
        .split('')
        .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
        .join('') +
      '$',
    'i',
  );
  return re.test(name);
}

interface OpenFile {
  readonly path: string;
  position: number;
  readonly write: boolean;
  readonly deleteOnClose: boolean;
}

/**
 * `kernel32.dll` for one process. `userLanguage` is the user's UI language (`0x0411` for
 * Japanese), which `FormatMessageW` uses when the caller passes no language.
 */
export interface Kernel32Options {
  /** The user's UI language (`0x0411` Japanese), for `FormatMessageW` without a language. */
  readonly userLanguage: number;
  /** The local file system; none by default. */
  readonly files?: WindowsLocalFiles;
  /** The current directory at start (the executable's folder); `c:\` by default. */
  readonly currentDirectory?: string;
  /** The process environment (names are case-insensitive). */
  readonly environment?: Readonly<Record<string, string>>;
  /** The page's named mutexes, shared with the code that creates them. */
  readonly mutexes?: PageWindowsNamedMutexes;
}

export function kernel32Library(
  options: Kernel32Options,
): NativeLibraryImplementation<Kernel32Exports> {
  const userLanguage = options.userLanguage;
  const files = options.files ?? NO_LOCAL_FILES;
  const currentDirectory = options.currentDirectory ?? 'c:\\';
  return {
    contract: KERNEL32,
    identities: [{kind: 'system', fileName: 'kernel32.dll'}],
    imports: [],
    link() {
      let lastError = 0;
      // The global atom table: name (case-insensitive) → atom and reference count.
      const atoms = new Map<string, {atom: number; refs: number}>();
      let nextAtom = 0xc000;
      let cwd = currentDirectory;
      const handles = new Map<number, OpenFile>();
      const mutexHandles = new Set<number>();
      // Environment variables: upper-case key → [name as set, value].
      const env = new Map<string, [string, string]>(
        Object.entries(options.environment ?? {}).map(([k, v]) => [k.toUpperCase(), [k, v]]),
      );
      let nextHandle = 0x100;
      const full = (path: string) => fullPathName(path, cwd);
      const fail = (code: number) => {
        lastError = code;
        return false;
      };
      const done = (code: number) => (code ? fail(code) : true);
      const exports: Kernel32Exports = {
        GetFileAttributesW: (path) => {
          const info = files.stat(full(path));
          if (!info) {
            lastError = ERROR_FILE_NOT_FOUND;
            return INVALID_FILE_ATTRIBUTES;
          }
          return info.attributes >>> 0;
        },
        GetFileAttributesExW: (path) => {
          const info = files.stat(full(path));
          if (!info) lastError = ERROR_FILE_NOT_FOUND;
          return info;
        },
        SetFileAttributesW: (path, attributes) => done(files.setAttributes(full(path), attributes)),
        FindFiles: (pattern) => {
          const p = full(pattern);
          const cut = p.lastIndexOf('\\');
          const dir = p.slice(0, cut + 1);
          const mask = p.slice(cut + 1);
          const list = files.list(dir);
          if (typeof list === 'number') {
            lastError = list;
            return null;
          }
          const entries: WindowsFileInfo[] = [];
          // FindFirstFile reports `.` and `..` in every directory but a root.
          if (!/^([a-z]:|\\\\[^\\]+\\[^\\]+)\\$/i.test(dir)) {
            const self = files.stat(dir);
            const parent = files.stat(dir.replace(/[^\\]+\\$/, '')) ?? self;
            if (self) entries.push({...self, name: '.'});
            if (parent) entries.push({...parent, name: '..'});
          }
          entries.push(...list);
          const found = entries.filter((e) => wildcardMatch(mask, e.name));
          if (!found.length) {
            lastError = ERROR_FILE_NOT_FOUND;
            return null;
          }
          return found;
        },
        CreateFileW: (path, access, _share, disposition, flags) => {
          const p = full(path);
          const info = files.stat(p);
          if (
            info &&
            info.attributes & FILE_ATTRIBUTE_DIRECTORY &&
            !(flags & FILE_FLAG_BACKUP_SEMANTICS)
          ) {
            lastError = ERROR_ACCESS_DENIED;
            return INVALID_HANDLE_VALUE;
          }
          if (!info) {
            if (
              disposition === CREATE_NEW ||
              disposition === CREATE_ALWAYS ||
              disposition === OPEN_ALWAYS
            ) {
              const code = files.write(p, new Uint8Array(0));
              if (code) {
                lastError = code;
                return INVALID_HANDLE_VALUE;
              }
            } else {
              lastError = ERROR_FILE_NOT_FOUND;
              return INVALID_HANDLE_VALUE;
            }
          } else if (disposition === CREATE_NEW) {
            lastError = ERROR_FILE_EXISTS;
            return INVALID_HANDLE_VALUE;
          } else if (disposition === CREATE_ALWAYS) {
            files.write(p, new Uint8Array(0));
          }
          const h = nextHandle;
          nextHandle += 4;
          handles.set(h, {
            path: p,
            position: 0,
            write: (access & GENERIC_WRITE) !== 0,
            deleteOnClose: (flags & FILE_FLAG_DELETE_ON_CLOSE) !== 0,
          });
          return h;
        },
        GetEnvironmentVariableW: (name) => {
          const v = env.get(name.toUpperCase());
          if (!v) {
            lastError = 203; // ERROR_ENVVAR_NOT_FOUND
            return null;
          }
          return v[1];
        },
        SetEnvironmentVariableW: (name, value) => {
          if (!name || name.includes('=')) return fail(ERROR_INVALID_PARAMETER);
          if (value === null) env.delete(name.toUpperCase());
          else env.set(name.toUpperCase(), [name, value]);
          return true;
        },
        ExpandEnvironmentStringsW: (source) =>
          source.replace(/%([^%]+)%/g, (m, name: string) => env.get(name.toUpperCase())?.[1] ?? m),
        OpenMutexW: (name) => {
          if (!options.mutexes?.isOpen(name)) {
            lastError = ERROR_FILE_NOT_FOUND;
            return 0;
          }
          const h = nextHandle;
          nextHandle += 4;
          mutexHandles.add(h);
          return h;
        },
        WaitForSingleObject: (handle) => {
          if (mutexHandles.has(handle)) return WAIT_OBJECT_0;
          lastError = ERROR_INVALID_HANDLE;
          return WAIT_FAILED;
        },
        CloseHandle: (handle) => {
          if (mutexHandles.delete(handle)) return true;
          const f = handles.get(handle);
          if (!f) return fail(ERROR_INVALID_HANDLE);
          handles.delete(handle);
          if (f.deleteOnClose && ![...handles.values()].some((o) => o.path === f.path)) {
            const info = files.stat(f.path);
            if (info) {
              if (info.attributes & FILE_ATTRIBUTE_DIRECTORY) files.removeDirectory(f.path);
              else files.deleteFile(f.path);
            }
          }
          return true;
        },
        GetFileTime: (handle) => {
          const f = handles.get(handle);
          const info = f ? files.stat(f.path) : null;
          if (!info) {
            lastError = f ? ERROR_FILE_NOT_FOUND : ERROR_INVALID_HANDLE;
            return null;
          }
          return {creation: info.creationTime, access: info.accessTime, write: info.writeTime};
        },
        SetFileTime: (handle, creation, access, write) => {
          const f = handles.get(handle);
          if (!f) return fail(ERROR_INVALID_HANDLE);
          if (!f.write) return fail(ERROR_ACCESS_DENIED);
          return done(files.setTimes(f.path, creation, access, write));
        },
        GetFileSizeEx: (handle) => {
          const f = handles.get(handle);
          const info = f ? files.stat(f.path) : null;
          if (!info) {
            lastError = f ? ERROR_FILE_NOT_FOUND : ERROR_INVALID_HANDLE;
            return null;
          }
          return info.size;
        },
        ReadFile: (handle, length) => {
          const f = handles.get(handle);
          if (!f) {
            lastError = ERROR_INVALID_HANDLE;
            return null;
          }
          const data = files.read(f.path);
          if (typeof data === 'number') {
            lastError = data;
            return null;
          }
          const out = data.slice(f.position, f.position + length);
          f.position += out.length;
          return out;
        },
        WriteFile: (handle, data) => {
          const f = handles.get(handle);
          if (!f || !f.write) {
            lastError = f ? ERROR_ACCESS_DENIED : ERROR_INVALID_HANDLE;
            return null;
          }
          const cur = files.read(f.path);
          const old = typeof cur === 'number' ? new Uint8Array(0) : cur;
          const next = new Uint8Array(Math.max(old.length, f.position + data.length));
          next.set(old);
          next.set(data, f.position);
          const code = files.write(f.path, next);
          if (code) {
            lastError = code;
            return null;
          }
          f.position += data.length;
          return data.length;
        },
        SetEndOfFileAt: (handle, size) => {
          const f = handles.get(handle);
          if (!f) return fail(ERROR_INVALID_HANDLE);
          if (!f.write) return fail(ERROR_ACCESS_DENIED);
          return done(files.truncate(f.path, Number(size)));
        },
        DeleteFileW: (path) => done(files.deleteFile(full(path))),
        MoveFileW: (from, to) => done(files.moveFile(full(from), full(to))),
        CopyFileW: (from, to, failIfExists) =>
          done(files.copyFile(full(from), full(to), failIfExists)),
        CreateDirectoryW: (path) => done(files.createDirectory(full(path))),
        RemoveDirectoryW: (path) => done(files.removeDirectory(full(path))),
        GetCurrentDirectoryW: () => cwd,
        SetCurrentDirectoryW: (path) => {
          const p = full(path);
          const info = files.stat(p);
          if (!info || !(info.attributes & FILE_ATTRIBUTE_DIRECTORY))
            return fail(ERROR_PATH_NOT_FOUND);
          cwd = p.replace(/\\$/, '') || p;
          if (/^[a-z]:$/i.test(cwd)) cwd += '\\';
          return true;
        },
        SearchPathW: (path, fileName) => {
          const dirs = path !== null ? path.split(';').filter(Boolean) : [cwd];
          for (const dir of dirs) {
            const p = fullPathName(fileName, dir.endsWith('\\') ? dir : dir + '\\');
            if (files.stat(p)) return p;
          }
          lastError = ERROR_FILE_NOT_FOUND;
          return null;
        },
        GetACP: () => ANSI_CODE_PAGE,
        MultiByteToWideChar: (codePage, bytes) => {
          const cp = codePage === CP_ACP ? ANSI_CODE_PAGE : codePage;
          if (cp === 932) return decodeCp932(bytes);
          if (cp === CP_UTF8) return new TextDecoder('utf-8').decode(bytes);
          lastError = ERROR_INVALID_PARAMETER;
          return null;
        },
        WideCharToMultiByte: (codePage, text) => {
          const cp = codePage === CP_ACP ? ANSI_CODE_PAGE : codePage;
          if (cp === 932) return encodeCp932(text);
          if (cp === CP_UTF8) return new TextEncoder().encode(text);
          lastError = ERROR_INVALID_PARAMETER;
          return null;
        },
        GlobalAddAtomW: (name) => {
          const key = name.toLowerCase();
          const entry = atoms.get(key);
          if (entry) {
            entry.refs++;
            return entry.atom;
          }
          if (nextAtom > 0xffff) return 0;
          atoms.set(key, {atom: nextAtom, refs: 1});
          return nextAtom++;
        },
        GlobalDeleteAtom: (atom) => {
          for (const [key, entry] of atoms)
            if (entry.atom === atom) {
              if (--entry.refs === 0) atoms.delete(key);
              return 0;
            }
          return atom;
        },
        GetLastError: () => lastError,
        SetLastError: (code) => {
          lastError = code >>> 0;
        },
        FormatMessageW: (flags, messageId, languageId) => {
          if (
            !(flags & FORMAT_MESSAGE_FROM_SYSTEM) ||
            flags & (FORMAT_MESSAGE_FROM_STRING | FORMAT_MESSAGE_FROM_HMODULE)
          ) {
            lastError = ERROR_INVALID_PARAMETER;
            return null;
          }
          const text = SYSTEM_MESSAGES.get(messageId >>> 0);
          if (!text) {
            lastError = ERROR_MR_MID_NOT_FOUND;
            return null;
          }
          // LANG_NEUTRAL + SUBLANG_DEFAULT (0x0400) and 0 select the user's language.
          const language = (languageId & 0x3ff) === 0 ? userLanguage : languageId;
          return ((language & 0x3ff) === LANG_JAPANESE ? text.ja : text.en) + '\r\n';
        },
      };
      return {exports};
    },
  };
}

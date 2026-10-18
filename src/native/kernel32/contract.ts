import {defineNativeContract} from '../../platform/native-libraries.js';

/** What `GetFileAttributesExW` / `FindFirstFileW` report of an entry (`WIN32_FIND_DATAW`). */
export interface WindowsFileInfo {
  /** The entry's own name (no directory), as stored. */
  readonly name: string;
  readonly attributes: number;
  readonly size: bigint;
  /** `FILETIME`s: 100 ns units since 1601. */
  readonly creationTime: bigint;
  readonly accessTime: bigint;
  readonly writeTime: bigint;
}

/**
 * `kernel32.dll` as the libraries of a process share it: the thread's last error, which every
 * system library sets and every caller reads, and the system message table behind
 * `FormatMessageW(FORMAT_MESSAGE_FROM_SYSTEM)`.
 */
export interface Kernel32Exports {
  GetLastError(): number;
  SetLastError(code: number): void;
  /**
   * `FormatMessageW(flags, NULL, messageId, languageId, …)` with `FORMAT_MESSAGE_FROM_SYSTEM`:
   * the system text of an error code with its trailing CRLF, or null when the call fails (no
   * text for the code, or a message source other than the system). `languageId` 0 (or
   * `LANG_NEUTRAL`/`SUBLANG_DEFAULT`) selects the user's language.
   */
  FormatMessageW(flags: number, messageId: number, languageId: number): string | null;
  /** `GetACP`: the ANSI code page. */
  GetACP(): number;
  /** `MultiByteToWideChar(codePage, 0, …)`: null for an unsupported code page. */
  MultiByteToWideChar(codePage: number, bytes: Uint8Array): string | null;
  /** `WideCharToMultiByte(codePage, 0, …)` without a default character. */
  WideCharToMultiByte(codePage: number, text: string): Uint8Array | null;
  /** `GlobalAddAtomW`/`A`: the atom of a name (0xC000–0xFFFF), 0 on failure. */
  GlobalAddAtomW(name: string): number;
  /** `GlobalDeleteAtom`: returns 0 on success, the atom otherwise. */
  GlobalDeleteAtom(atom: number): number;

  // Environment.
  /** `GetEnvironmentVariableW`: null when the variable is not set. */
  GetEnvironmentVariableW(name: string): string | null;
  /** `SetEnvironmentVariableW`; null deletes the variable. */
  SetEnvironmentVariableW(name: string, value: string | null): boolean;
  /** `ExpandEnvironmentStringsW`: `%NAME%` of set variables replaced. */
  ExpandEnvironmentStringsW(source: string): string;

  // Synchronisation. Every mutex of the page is owned by the one UI thread.
  /** `OpenMutexW(SYNCHRONIZE, FALSE, name)`: a handle, 0 when no mutex has the name. */
  OpenMutexW(name: string): number;
  /** `WaitForSingleObject`: `WAIT_OBJECT_0` (0) for a mutex the thread owns. */
  WaitForSingleObject(handle: number, timeout: number): number;

  // Files. Paths are Windows path names; relative names resolve against the current directory.
  /** `INVALID_FILE_ATTRIBUTES` (0xFFFFFFFF) when the entry does not exist. */
  GetFileAttributesW(path: string): number;
  /** `GetFileAttributesExW(GetFileExInfoStandard)`: null on failure. */
  GetFileAttributesExW(path: string): WindowsFileInfo | null;
  SetFileAttributesW(path: string, attributes: number): boolean;
  /** `FindFirstFileW` with `FindNextFileW` until the end: the entries matching `pattern`. */
  FindFiles(pattern: string): WindowsFileInfo[] | null;
  /**
   * `CreateFileW(path, access, share, NULL, disposition, flags, NULL)`: a handle, or
   * `INVALID_HANDLE_VALUE` (-1). `FILE_FLAG_BACKUP_SEMANTICS` opens directories;
   * `FILE_FLAG_DELETE_ON_CLOSE` deletes the entry when the last handle closes.
   */
  CreateFileW(
    path: string,
    access: number,
    share: number,
    disposition: number,
    flags: number,
  ): number;
  CloseHandle(handle: number): boolean;
  /** `GetFileTime`: creation, access, write; null on failure. */
  GetFileTime(handle: number): {creation: bigint; access: bigint; write: bigint} | null;
  SetFileTime(
    handle: number,
    creation: bigint | null,
    access: bigint | null,
    write: bigint | null,
  ): boolean;
  GetFileSizeEx(handle: number): bigint | null;
  /** `ReadFile`: up to `length` bytes at the file position, null on failure. */
  ReadFile(handle: number, length: number): Uint8Array | null;
  /** `WriteFile` at the file position: the bytes written, null on failure. */
  WriteFile(handle: number, data: Uint8Array): number | null;
  /** `SetFilePointerEx(FILE_BEGIN)` then `SetEndOfFile`: sets the file size. */
  SetEndOfFileAt(handle: number, size: bigint): boolean;
  DeleteFileW(path: string): boolean;
  MoveFileW(from: string, to: string): boolean;
  CopyFileW(from: string, to: string, failIfExists: boolean): boolean;
  CreateDirectoryW(path: string): boolean;
  RemoveDirectoryW(path: string): boolean;
  /** The current directory, without a trailing backslash except for a root (`c:\`). */
  GetCurrentDirectoryW(): string;
  SetCurrentDirectoryW(path: string): boolean;
  /** `SearchPathW(path, file, NULL)`: the full name, or null. */
  SearchPathW(path: string | null, fileName: string): string | null;
}

export const WAIT_OBJECT_0 = 0;
export const WAIT_ABANDONED = 0x80;
export const WAIT_TIMEOUT = 0x102;
export const WAIT_FAILED = 0xffffffff;
export const CP_ACP = 0;
export const CP_UTF8 = 65001;
export const INVALID_HANDLE_VALUE = -1;
export const GENERIC_READ = 0x80000000 | 0;
export const GENERIC_WRITE = 0x40000000;
export const READ_CONTROL = 0x00020000;
export const FILE_SHARE_READ = 1;
export const FILE_SHARE_WRITE = 2;
export const FILE_SHARE_DELETE = 4;
export const CREATE_NEW = 1;
export const CREATE_ALWAYS = 2;
export const OPEN_EXISTING = 3;
export const OPEN_ALWAYS = 4;
export const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
export const FILE_FLAG_DELETE_ON_CLOSE = 0x04000000;

export const FORMAT_MESSAGE_ALLOCATE_BUFFER = 0x00000100;
export const FORMAT_MESSAGE_IGNORE_INSERTS = 0x00000200;
export const FORMAT_MESSAGE_FROM_STRING = 0x00000400;
export const FORMAT_MESSAGE_FROM_HMODULE = 0x00000800;
export const FORMAT_MESSAGE_FROM_SYSTEM = 0x00001000;

export const ERROR_SUCCESS = 0;
export const ERROR_FILE_NOT_FOUND = 2;
export const ERROR_INVALID_PARAMETER = 87;
export const ERROR_MOD_NOT_FOUND = 126;
export const ERROR_RESOURCE_TYPE_NOT_FOUND = 1813;
export const ERROR_RESOURCE_NAME_NOT_FOUND = 1814;
export const ERROR_MR_MID_NOT_FOUND = 317;

export const KERNEL32 = defineNativeContract<Kernel32Exports>('kernel32.dll', '1');

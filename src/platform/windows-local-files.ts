/**
 * The local file system of an emulated Windows process, as `kernel32.dll` file functions see it:
 * Windows path names (`c:\game\savedata\x.dat`), attributes, sizes, the three file times and
 * the operations that change them. Calls are synchronous, as the Win32 functions are; a host
 * keeps an index of the files it serves and persists changes on its own schedule.
 *
 * File times are `FILETIME` values (100 ns units since 1601-01-01 UTC) as bigints. Failures
 * are Win32 error codes (`ERROR_*`); 0 is success.
 */

export const FILE_ATTRIBUTE_READONLY = 0x00000001;
export const FILE_ATTRIBUTE_HIDDEN = 0x00000002;
export const FILE_ATTRIBUTE_SYSTEM = 0x00000004;
export const FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
export const FILE_ATTRIBUTE_ARCHIVE = 0x00000020;
export const FILE_ATTRIBUTE_NORMAL = 0x00000080;
export const FILE_ATTRIBUTE_TEMPORARY = 0x00000100;
export const INVALID_FILE_ATTRIBUTES = 0xffffffff;

export const ERROR_FILE_NOT_FOUND = 2;
export const ERROR_PATH_NOT_FOUND = 3;
export const ERROR_ACCESS_DENIED = 5;
export const ERROR_NOT_SAME_DEVICE = 17;
export const ERROR_FILE_EXISTS = 80;
export const ERROR_DIR_NOT_EMPTY = 145;
export const ERROR_ALREADY_EXISTS = 183;

/** What `GetFileAttributesExW` / `FindFirstFileW` report of an entry. */
export interface WindowsFileInfo {
  /** The entry's own name (no directory), as stored. */
  readonly name: string;
  readonly attributes: number;
  readonly size: bigint;
  readonly creationTime: bigint;
  readonly accessTime: bigint;
  readonly writeTime: bigint;
}

export interface WindowsLocalFiles {
  /** The entry at a path, or null when it does not exist. */
  stat(path: string): WindowsFileInfo | null;
  /** The entries of a directory (without `.` and `..`), or an error code. */
  list(directory: string): readonly WindowsFileInfo[] | number;
  /** The bytes of a file (`CreateFileW` + `ReadFile`), or an error code. */
  read(path: string): Uint8Array | number;
  /** Replaces a file's bytes, creating it (`CREATE_ALWAYS`). */
  write(path: string, data: Uint8Array): number;
  deleteFile(path: string): number;
  /** `MoveFileW`: fails when `to` exists. */
  moveFile(from: string, to: string): number;
  /** `CopyFileW`. */
  copyFile(from: string, to: string, failIfExists: boolean): number;
  createDirectory(path: string): number;
  /** `RemoveDirectoryW`: only empty directories. */
  removeDirectory(path: string): number;
  setAttributes(path: string, attributes: number): number;
  /** `SetFileTime`; null leaves a time unchanged. */
  setTimes(
    path: string,
    creation: bigint | null,
    access: bigint | null,
    write: bigint | null,
  ): number;
  /** `SetFilePointerEx` + `SetEndOfFile`. */
  truncate(path: string, size: number): number;
}

/** `FILETIME` of a JavaScript time (milliseconds since 1970). */
export function fileTimeFromUnixMs(ms: number): bigint {
  return BigInt(Math.round(ms)) * 10000n + 0x19db1ded53e8000n;
}

/** A file system without files: every lookup fails with `ERROR_PATH_NOT_FOUND`. */
export const NO_LOCAL_FILES: WindowsLocalFiles = {
  stat: () => null,
  list: () => ERROR_PATH_NOT_FOUND,
  read: () => ERROR_PATH_NOT_FOUND,
  write: () => ERROR_ACCESS_DENIED,
  deleteFile: () => ERROR_FILE_NOT_FOUND,
  moveFile: () => ERROR_FILE_NOT_FOUND,
  copyFile: () => ERROR_FILE_NOT_FOUND,
  createDirectory: () => ERROR_PATH_NOT_FOUND,
  removeDirectory: () => ERROR_PATH_NOT_FOUND,
  setAttributes: () => ERROR_FILE_NOT_FOUND,
  setTimes: () => ERROR_FILE_NOT_FOUND,
  truncate: () => ERROR_FILE_NOT_FOUND,
};

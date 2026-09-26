/** Selected native library and export identities; neither is a browser URL or JavaScript module. */
export type WindowsDynamicLibrary = object;
export type WindowsDynamicProcedure = object;
export type WindowsNativeWindowHandle = object;

/** A pointer borrowed from an engine's live memory for one synchronous native call. */
export interface WindowsBorrowedMemoryPointer {
  readonly bytes: Uint8Array;
  readonly offset: number;
}

export type WindowsDynamicArgument =
  | {readonly kind: 'signed'; readonly value: bigint}
  | {readonly kind: 'memory'; readonly pointer: WindowsBorrowedMemoryPointer | null}
  | {readonly kind: 'handle'; readonly value: WindowsNativeWindowHandle | null};

/**
 * Project-level LoadLibraryA/GetProcAddress/FreeLibrary and native-call boundary.
 * Every operation is synchronous. `invoke` must complete any borrowed-memory
 * reads or writes before returning; no ambient browser or developer-machine
 * library loader is implied by this interface.
 */
export interface WindowsDynamicLibraryHost {
  loadLibraryA(path: Uint8Array): WindowsDynamicLibrary | null;
  getProcAddress(
    library: WindowsDynamicLibrary,
    exportName: string,
  ): WindowsDynamicProcedure | null;
  invoke(
    procedure: WindowsDynamicProcedure,
    arguments_: readonly WindowsDynamicArgument[],
  ): bigint | void;
  freeLibrary(library: WindowsDynamicLibrary): void;
  /** Resolve the selected native HWND associated with the actual window owner. */
  mainWindowHandle(windowIdentity: object): WindowsNativeWindowHandle | null;
}

/** Browsers cannot load or call native DLL exports. Win32 load/query returns failure. */
export class BrowserWindowsDynamicLibraryHost implements WindowsDynamicLibraryHost {
  loadLibraryA(_path: Uint8Array): WindowsDynamicLibrary | null { return null; }
  getProcAddress(
    _library: WindowsDynamicLibrary,
    _exportName: string,
  ): WindowsDynamicProcedure | null { return null; }
  invoke(
    _procedure: WindowsDynamicProcedure,
    _arguments: readonly WindowsDynamicArgument[],
  ): bigint | void { return undefined; }
  freeLibrary(_library: WindowsDynamicLibrary): void {}
  mainWindowHandle(_windowIdentity: object): WindowsNativeWindowHandle | null { return null; }
}

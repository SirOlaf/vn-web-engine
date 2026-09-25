/** Opaque kernel-handle identity supplied by a selected Windows-compatible host. */
export type WindowsProcessHandle = object;

export interface WindowsProcessInformation {
  readonly process: WindowsProcessHandle;
  readonly thread: WindowsProcessHandle;
}

/** STARTUPINFOW fields consumed by the selected process host. */
export interface WindowsProcessStartup {
  readonly cb: number;
  readonly reserved: null;
  readonly desktop: string | null;
  readonly title: string | null;
  readonly x: number;
  readonly y: number;
  readonly xSize: number;
  readonly ySize: number;
  readonly xCountChars: number;
  readonly yCountChars: number;
  readonly fillAttribute: number;
  readonly flags: number;
  readonly showWindow: number;
  readonly reserved2Size: number;
  readonly reserved2: null;
  readonly standardInput: WindowsProcessHandle | null;
  readonly standardOutput: WindowsProcessHandle | null;
  readonly standardError: WindowsProcessHandle | null;
}

export interface WindowsProcessRequest {
  readonly applicationName: string | null;
  /** CreateProcess may modify this inclusive-NUL UTF-16 buffer. */
  readonly commandLine: Uint16Array;
  readonly processAttributes: null;
  readonly threadAttributes: null;
  readonly inheritHandles: boolean;
  readonly creationFlags: number;
  readonly environment: null;
  readonly currentDirectory: string | null;
  readonly startup: WindowsProcessStartup;
}

type HostResult<T> = T | Promise<T>;

/** Selected Windows process, shell-token, wait and kernel-handle primitives. */
export interface WindowsProcessHost {
  isUserAdministrator(): HostResult<boolean>;
  readShellWindowProcessId(): HostResult<number | null>;
  openProcess(
    desiredAccess: number,
    inheritHandle: boolean,
    processId: number,
  ): HostResult<WindowsProcessHandle | null>;
  openProcessToken(
    process: WindowsProcessHandle,
    desiredAccess: number,
  ): HostResult<WindowsProcessHandle | null>;
  duplicateTokenEx(
    token: WindowsProcessHandle,
    desiredAccess: number,
    securityAttributes: null,
    impersonationLevel: number,
    tokenType: number,
  ): HostResult<WindowsProcessHandle | null>;
  createProcessWithTokenW(
    token: WindowsProcessHandle,
    logonFlags: number,
    request: WindowsProcessRequest,
  ): HostResult<WindowsProcessInformation | null>;
  createProcessW(request: WindowsProcessRequest): HostResult<WindowsProcessInformation | null>;
  waitForInputIdle(process: WindowsProcessHandle, milliseconds: number): HostResult<number>;
  waitForSingleObject(process: WindowsProcessHandle, milliseconds: number): HostResult<number>;
  readExitCodeProcess(process: WindowsProcessHandle): HostResult<number | null>;
  openMutexA(
    desiredAccess: number,
    inheritHandle: boolean,
    name: Uint8Array,
  ): HostResult<WindowsProcessHandle | null>;
  sleep(milliseconds: number): HostResult<void>;
  closeHandle(handle: WindowsProcessHandle): void;
}

/** Borrow the shell's primary token, closing both temporary handles in native order. */
export async function duplicateWindowsShellPrimaryToken(
  host: WindowsProcessHost,
): Promise<WindowsProcessHandle | null> {
  const processId = await host.readShellWindowProcessId();
  if (processId === null) return null;
  const process = await host.openProcess(0x02000000, false, processId >>> 0);
  if (process === null) return null;
  let token: WindowsProcessHandle | null;
  try {
    token = await host.openProcessToken(process, 0x02000000);
  } finally {
    host.closeHandle(process);
  }
  if (token === null) return null;
  try {
    return await host.duplicateTokenEx(token, 0x02000000, null, 3, 1);
  } finally {
    host.closeHandle(token);
  }
}

/**
 * Synchronous shell impersonation and ShellExecute primitives. The caller must
 * complete impersonate, execute, revert and token close in one JS turn so an
 * awaited host continuation cannot run under the borrowed shell identity.
 */
export interface WindowsShellExecuteHost extends WindowsProcessHost {
  impersonateLoggedOnUser(token: WindowsProcessHandle): boolean;
  shellExecuteW(
    parent: null,
    operation: string,
    file: string,
    parameters: string | null,
    directory: string | null,
    showCommand: number,
  ): number | bigint;
  revertToSelf(): boolean;
}

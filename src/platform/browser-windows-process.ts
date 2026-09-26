import type {
  WindowsProcessHandle,
  WindowsProcessHost,
  WindowsProcessInformation,
  WindowsProcessRequest,
  WindowsShellExecuteHost,
} from './windows-process.js';

/** Browser process boundary: local Windows executables and kernel objects are unavailable. */
export class BrowserWindowsProcessHost implements WindowsProcessHost, WindowsShellExecuteHost {
  isUserAdministrator(): boolean {
    return false;
  }
  readShellWindowProcessId(): number | null {
    return null;
  }
  openProcess(_access: number, _inherit: boolean, _id: number): WindowsProcessHandle | null {
    return null;
  }
  openProcessToken(_process: WindowsProcessHandle, _access: number): WindowsProcessHandle | null {
    return null;
  }
  duplicateTokenEx(
    _token: WindowsProcessHandle,
    _access: number,
    _attributes: null,
    _level: number,
    _type: number,
  ): WindowsProcessHandle | null {
    return null;
  }
  createProcessWithTokenW(
    _token: WindowsProcessHandle,
    _flags: number,
    _request: WindowsProcessRequest,
  ): WindowsProcessInformation | null {
    return null;
  }
  createProcessW(_request: WindowsProcessRequest): WindowsProcessInformation | null {
    return null;
  }
  waitForInputIdle(_process: WindowsProcessHandle, _milliseconds: number): number {
    return 0xffffffff;
  }
  waitForSingleObject(_process: WindowsProcessHandle, _milliseconds: number): number {
    return 0xffffffff;
  }
  readExitCodeProcess(_process: WindowsProcessHandle): number | null {
    return null;
  }
  openMutexA(_access: number, _inherit: boolean, _name: Uint8Array): WindowsProcessHandle | null {
    return null;
  }
  sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
  }
  closeHandle(_handle: WindowsProcessHandle): void {}
  impersonateLoggedOnUser(_token: WindowsProcessHandle): boolean { return false; }
  shellExecuteW(
    _parent: null,
    _operation: string,
    _file: string,
    _parameters: string | null,
    _directory: string | null,
    _showCommand: number,
  ): number { return 0; }
  revertToSelf(): boolean { return true; }
}

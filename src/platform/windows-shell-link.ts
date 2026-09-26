/** Browser CoCreateInstance for the Windows ShellLink COM class fails. */
export class BrowserWindowsShellLinkHost {
  createShellLink(): {hresult: number; link: null} {
    return {hresult: 0x80040154, link: null};
  }
}

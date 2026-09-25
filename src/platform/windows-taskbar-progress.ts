/** ITaskbarList3::SetProgressState lifetime boundary for installer work. */
export interface WindowsTaskbarProgressLease {
  setProgressState(owner: object, state: 0 | 2): void;
  release(): void;
}

export interface WindowsTaskbarProgressHost {
  createTaskbarList3(): WindowsTaskbarProgressLease | null;
}

/** Browser profile: the project-level taskbar effect has no OS target. */
export class BrowserWindowsTaskbarProgressHost implements WindowsTaskbarProgressHost {
  createTaskbarList3(): null { return null; }
}

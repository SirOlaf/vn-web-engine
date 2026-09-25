export interface WindowsProcessInstanceLease {
  release(): void;
}

/** Project-level boundary for the outer WinMain single-instance admission. */
export interface WindowsProcessInstanceHost {
  acquire(name: string): Promise<WindowsProcessInstanceLease | null>;
}

/** Browser-scoped process instance policy. Embeddings can replace this with an
 * OS-backed host; browser execution cannot acquire a Windows kernel mutex. */
export class BrowserWindowsProcessInstanceHost implements WindowsProcessInstanceHost {
  private static readonly held = new Set<string>();

  async acquire(name: string): Promise<WindowsProcessInstanceLease | null> {
    if (BrowserWindowsProcessInstanceHost.held.has(name)) return null;
    BrowserWindowsProcessInstanceHost.held.add(name);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        BrowserWindowsProcessInstanceHost.held.delete(name);
      },
    };
  }
}

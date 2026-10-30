/** Win32 window state commands issued by engines (IsIconic/ShowWindow and the engine's
 * own windowed/fullscreen toggle). The platform decides the host effect.
 */
export interface WindowStateHost {
  /** IsIconic for the engine's main window. */
  minimized(): boolean;
  /** ShowWindow SW_MINIMIZE (6) or SW_RESTORE (9). Native ignores the result. */
  show(command: 'minimize' | 'restore'): void;
  /** Switch the main window between windowed and fullscreen presentation. */
  toggleFullscreen(): void;
}

/** A page cannot iconify its browser window. A hidden document reports as minimized,
 * minimize requests are reported to the user, and fullscreen uses the page's display host.
 */
export class BrowserWindowStateHost implements WindowStateHost {
  constructor(
    private readonly document: Pick<Document, 'visibilityState'> | null,
    private readonly display: {toggleFullscreen(): void},
    private readonly report: (message: string) => void = () => {},
  ) {}
  minimized(): boolean {
    return this.document?.visibilityState === 'hidden';
  }
  show(command: 'minimize' | 'restore'): void {
    if (command === 'minimize')
      this.report('The browser does not allow a page to minimize its window.');
  }
  toggleFullscreen(): void {
    this.display.toggleFullscreen();
  }
}

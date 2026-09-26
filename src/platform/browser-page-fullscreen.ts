import {
  browserFullscreenAvailable,
  browserFullscreenElement,
  requestBrowserFullscreen,
  type BrowserFullscreenElement,
} from './browser-fullscreen.js';
import type {BrowserFullscreenMode} from './browser-window-display.js';

/** Page fullscreen leaves renderer geometry and the game's display state untouched. */
export class BrowserPageFullscreenHost {
  private modeValue: BrowserFullscreenMode = 'page';
  private expanded = false;
  private pending = false;
  private blocked = false;

  constructor(
    readonly root: BrowserFullscreenElement,
    private readonly changed: () => void = () => {},
    private readonly report: (message: string) => void = () => {},
  ) {
    try {
      if (root.ownerDocument.defaultView?.localStorage.getItem('vn.fullscreen-mode') === 'screen')
        this.modeValue = 'screen';
    } catch {
      /* Optional preference. */
    }
    for (const name of ['fullscreenchange', 'webkitfullscreenchange'])
      root.ownerDocument.addEventListener(name, this.fullscreenChanged);
  }

  get mode(): BrowserFullscreenMode {
    return this.modeValue;
  }
  get isExpanded(): boolean {
    return this.expanded;
  }
  get isScreenFullscreen(): boolean {
    return browserFullscreenElement(this.root.ownerDocument) === this.root;
  }
  get screenFullscreenAvailable(): boolean {
    return browserFullscreenAvailable(this.root);
  }

  setMode(mode: BrowserFullscreenMode): void {
    this.modeValue = mode;
    this.blocked = false;
    try {
      this.root.ownerDocument.defaultView?.localStorage.setItem('vn.fullscreen-mode', mode);
    } catch {
      /* Optional preference. */
    }
    this.synchronize();
    this.changed();
  }

  setFullscreen(active: boolean): void {
    this.expanded = active;
    this.blocked = false;
    this.root.toggleAttribute('data-expanded', active);
    this.synchronize();
    this.changed();
  }

  toggleFullscreen(): void {
    this.setFullscreen(
      this.expanded && this.mode === 'screen' && !this.isScreenFullscreen ? true : !this.expanded,
    );
  }

  private readonly fullscreenChanged = (): void => {
    if (!this.isScreenFullscreen && this.expanded && this.mode === 'screen') this.blocked = true;
    this.changed();
  };

  private synchronize(): void {
    const active = this.expanded && this.mode === 'screen';
    if (this.pending || active === this.isScreenFullscreen || (active && this.blocked)) return;
    let result: void | Promise<void>;
    try {
      result = requestBrowserFullscreen(this.root, active);
    } catch {
      this.failed(active);
      return;
    }
    this.pending = true;
    void Promise.resolve(result)
      .catch(() => this.failed(active))
      .finally(() => {
        this.pending = false;
        if (active !== (this.expanded && this.mode === 'screen')) this.synchronize();
        this.changed();
      });
  }

  private failed(entering: boolean): void {
    this.blocked = true;
    this.report(
      entering
        ? 'Using the page-filling view. Press Enter fullscreen to request browser fullscreen, or select Fill browser page.'
        : 'The browser could not exit fullscreen. Use its fullscreen exit control.',
    );
    this.changed();
  }

  dispose(): void {
    this.setFullscreen(false);
    for (const name of ['fullscreenchange', 'webkitfullscreenchange'])
      this.root.ownerDocument.removeEventListener(name, this.fullscreenChanged);
  }
}

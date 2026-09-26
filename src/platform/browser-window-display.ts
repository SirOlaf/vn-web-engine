import type {
  ViewportScreenMapping,
  WindowDisplayGeometry,
  WindowDisplayHost,
} from './window-display.js';
import {BrowserWindowCoordinatesHost} from './browser-window-coordinates.js';
import {
  browserFullscreenElement,
  browserFullscreenAvailable,
  requestBrowserFullscreen,
  type BrowserFullscreenDocument,
  type BrowserFullscreenElement,
} from './browser-fullscreen.js';

export type BrowserFullscreenMode = 'page' | 'screen';
/** Browser screen dimensions are CSS pixels; native display queries use device pixels. */
export function browserDesktopSize(
  view: Pick<Window, 'screen' | 'devicePixelRatio'>,
): readonly [number, number] {
  const ratio =
    Number.isFinite(view.devicePixelRatio) && view.devicePixelRatio > 0 ? view.devicePixelRatio : 1;
  return [
    Math.max(800, Math.round((view.screen.width || 800) * ratio)),
    Math.max(600, Math.round((view.screen.height || 600) * ratio)),
  ];
}

/** Presents a native window within a page, retaining native geometry for input and child controls.
 * The entire window is scaled together; canvas storage and the engine's display mode are untouched.
 * Browser fullscreen denial leaves a usable page-filling view and an explicit retry control.
 */
export class BrowserWindowDisplayHost implements WindowDisplayHost {
  readonly coordinates: BrowserWindowCoordinatesHost;
  private readonly document: BrowserFullscreenDocument;
  private readonly view: Window;
  private geometry: WindowDisplayGeometry = {width: 800, height: 600, fullscreen: false};
  private x = 0;
  private y = 0;
  private scaleX = 1;
  private scaleY = 1;
  private expanded = false;
  private modeValue: BrowserFullscreenMode = 'page';
  private pending = false;
  private blocked = false;
  private disposed = false;
  private observer: ResizeObserver | null = null;

  constructor(
    readonly root: BrowserFullscreenElement,
    readonly viewport: HTMLElement,
    readonly windowElement: HTMLElement,
    private readonly changed: () => void = () => {},
    private readonly report: (message: string) => void = () => {},
    readonly auxiliaryLayer: HTMLElement = windowElement,
  ) {
    this.document = root.ownerDocument;
    this.view = this.document.defaultView!;
    this.coordinates = new BrowserWindowCoordinatesHost(auxiliaryLayer, () =>
      this.readViewportScreenMapping(),
    );
    try {
      if (this.view.localStorage.getItem('vn.fullscreen-mode') === 'screen')
        this.modeValue = 'screen';
    } catch {
      /* Browser storage can be disabled independently of presentation. */
    }
    for (const name of ['fullscreenchange', 'webkitfullscreenchange'])
      this.document.addEventListener(name, this.fullscreenChanged);
    this.view.addEventListener('resize', this.layout);
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(this.layout);
      this.observer.observe(viewport);
    }
    windowElement.style.width = '800px';
    windowElement.style.height = '600px';
    this.layout();
  }

  get mode(): BrowserFullscreenMode {
    return this.modeValue;
  }
  get isExpanded(): boolean {
    return this.expanded;
  }
  get isScreenFullscreen(): boolean {
    return browserFullscreenElement(this.document) === this.root;
  }
  get screenFullscreenAvailable(): boolean {
    return browserFullscreenAvailable(this.root);
  }

  setMode(mode: BrowserFullscreenMode): void {
    this.modeValue = mode;
    this.blocked = false;
    try {
      this.view.localStorage.setItem('vn.fullscreen-mode', mode);
    } catch {
      /* Optional preference. */
    }
    this.synchronizeFullscreen();
    this.changed();
  }

  setFullscreen(active: boolean): void {
    this.expanded = active;
    this.blocked = false;
    this.root.toggleAttribute('data-expanded', active);
    this.layout();
    this.synchronizeFullscreen();
    this.changed();
  }

  /** Also serves as a user-activation retry after a deferred native fullscreen request. */
  toggleFullscreen(): void {
    this.setFullscreen(
      this.expanded && this.mode === 'screen' && !this.isScreenFullscreen ? true : !this.expanded,
    );
  }

  configure(geometry: WindowDisplayGeometry): void {
    const modeChanged = geometry.fullscreen !== this.geometry.fullscreen;
    this.geometry = {...geometry};
    if (modeChanged) this.setFullscreen(geometry.fullscreen);
    else this.layout();
  }

  /** A page has a virtual desktop; moving its window changes native coordinates, not page scroll. */
  setPosition(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.coordinates.refresh();
  }

  readViewportScreenMapping(): ViewportScreenMapping {
    const rect = this.windowElement.getBoundingClientRect();
    return {
      originX: this.x - rect.left / this.scaleX,
      originY: this.y - rect.top / this.scaleY,
      nativePixelsPerCssX: 1 / this.scaleX,
      nativePixelsPerCssY: 1 / this.scaleY,
    };
  }

  private readonly layout = (): void => {
    if (this.disposed) return;
    const {width, height} = this.geometry;
    const availableWidth = Math.max(1, this.viewport.clientWidth);
    const availableHeight = Math.max(1, this.viewport.clientHeight);
    const ratio = this.view.devicePixelRatio > 0 ? this.view.devicePixelRatio : 1;
    // Native window dimensions are device pixels. Preserve their physical extent on
    // high-DPI screens; page/screen expansion is the separate user-controlled policy.
    const fittedScale = Math.min(availableWidth / width, availableHeight / height, 1 / ratio);
    this.scaleX = this.expanded ? availableWidth / width : fittedScale;
    this.scaleY = this.expanded ? availableHeight / height : fittedScale;
    this.viewport.style.height = this.expanded ? '' : `${height * this.scaleY}px`;
    for (const element of new Set([this.windowElement, this.auxiliaryLayer])) {
      const style = element.style;
      style.width = `${width}px`;
      style.height = `${height}px`;
      style.position = 'absolute';
      style.transformOrigin = 'top left';
      style.transform =
        this.scaleX === this.scaleY
          ? `scale(${this.scaleX})`
          : `scale(${this.scaleX}, ${this.scaleY})`;
      style.left = `${(availableWidth - width * this.scaleX) / 2}px`;
      style.top = `${(availableHeight - height * this.scaleY) / 2}px`;
    }
    this.coordinates.refresh();
  };

  private readonly fullscreenChanged = (): void => {
    // Escape retains native fullscreen's page-filling presentation. Browser policy is separate.
    if (!this.isScreenFullscreen && this.expanded && this.mode === 'screen') this.blocked = true;
    this.layout();
    this.changed();
  };

  private synchronizeFullscreen(): void {
    if (this.pending || (this.disposed && !this.isScreenFullscreen)) return;
    const wantsScreen = !this.disposed && this.expanded && this.mode === 'screen';
    if (wantsScreen === this.isScreenFullscreen || (wantsScreen && this.blocked)) return;
    let result: void | Promise<void>;
    try {
      // Invoke synchronously so clicks retain their transient user activation.
      result = requestBrowserFullscreen(this.root, wantsScreen);
    } catch {
      this.fullscreenFailed(wantsScreen);
      return;
    }
    this.pending = true;
    void Promise.resolve(result)
      .catch(() => this.fullscreenFailed(wantsScreen))
      .finally(() => {
        this.pending = false;
        // A preference or native mode may have changed while the browser request was pending.
        if (wantsScreen !== (this.expanded && this.mode === 'screen')) this.synchronizeFullscreen();
        this.layout();
        this.changed();
      });
  }

  private fullscreenFailed(entering: boolean): void {
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
    this.disposed = true;
    this.observer?.disconnect();
    this.view.removeEventListener('resize', this.layout);
    for (const name of ['fullscreenchange', 'webkitfullscreenchange'])
      this.document.removeEventListener(name, this.fullscreenChanged);
  }
}

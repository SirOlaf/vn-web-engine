export type BrowserFullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => void | Promise<void>;
};
export type BrowserFullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => void | Promise<void>;
};

export function browserFullscreenElement(document: BrowserFullscreenDocument): Element | null {
  return document.fullscreenElement ?? document.webkitFullscreenElement ?? null;
}

export function browserFullscreenAvailable(root: BrowserFullscreenElement): boolean {
  const document = root.ownerDocument as BrowserFullscreenDocument;
  return (
    (typeof root.requestFullscreen === 'function' &&
      typeof document.exitFullscreen === 'function' &&
      document.fullscreenEnabled !== false) ||
    (typeof root.webkitRequestFullscreen === 'function' &&
      typeof document.webkitExitFullscreen === 'function' &&
      document.webkitFullscreenEnabled !== false)
  );
}

/** Invoke in the original gesture; callers may await the returned browser transition. */
export function requestBrowserFullscreen(
  root: BrowserFullscreenElement,
  active: boolean,
): void | Promise<void> {
  const document = root.ownerDocument as BrowserFullscreenDocument;
  if (active) {
    if (!browserFullscreenAvailable(root)) throw new Error('Fullscreen unavailable');
    return typeof root.requestFullscreen === 'function' &&
      typeof document.exitFullscreen === 'function' &&
      document.fullscreenEnabled !== false
      ? root.requestFullscreen()
      : root.webkitRequestFullscreen!();
  }
  if (browserFullscreenElement(document) !== root) return;
  return document.fullscreenElement === root
    ? document.exitFullscreen()
    : document.webkitExitFullscreen!();
}

/** Expanded presentation keeps native proportions unless the player opts into stretching. */
export type BrowserFullscreenScaling = 'fit' | 'stretch';
const SCALING_KEY = 'vn.fullscreen-scaling';

export function readBrowserFullscreenScaling(
  view: Window | null | undefined,
): BrowserFullscreenScaling {
  try {
    return view?.localStorage.getItem(SCALING_KEY) === 'stretch' ? 'stretch' : 'fit';
  } catch {
    return 'fit'; // Browser storage can be disabled independently of presentation.
  }
}

export function writeBrowserFullscreenScaling(
  view: Window | null | undefined,
  scaling: BrowserFullscreenScaling,
): void {
  try {
    view?.localStorage.setItem(SCALING_KEY, scaling);
  } catch {
    /* Optional preference. */
  }
}

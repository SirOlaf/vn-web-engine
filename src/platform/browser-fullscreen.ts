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

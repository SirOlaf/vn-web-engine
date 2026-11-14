/** Whether a game window in this page is the active (foreground) window: the page is
 * visible and has focus. */
export function browserWindowActive(view: Window): boolean {
  return view.document.visibilityState === 'visible' && view.document.hasFocus();
}

/**
 * WM_ACTIVATE for a game window in a page: the window is active while its page is visible
 * and has focus. `changed` receives each change of that state; the returned function stops
 * watching.
 */
export function watchBrowserWindowActivation(
  view: Window,
  changed: (active: boolean) => void,
): () => void {
  const {document} = view;
  const current = (): boolean => browserWindowActive(view);
  let active = current();
  const update = (): void => {
    const next = current();
    if (next === active) return;
    active = next;
    changed(next);
  };
  view.addEventListener('focus', update);
  view.addEventListener('blur', update);
  document.addEventListener('visibilitychange', update);
  return () => {
    view.removeEventListener('focus', update);
    view.removeEventListener('blur', update);
    document.removeEventListener('visibilitychange', update);
  };
}

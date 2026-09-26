import type {BrowserFullscreenMode} from '../../src/platform/browser-window-display.js';

export interface PlayerFullscreenHost {
  readonly mode: BrowserFullscreenMode;
  readonly isExpanded: boolean;
  readonly isScreenFullscreen: boolean;
  readonly screenFullscreenAvailable: boolean;
  setMode(mode: BrowserFullscreenMode): void;
  toggleFullscreen(): void;
}

/** Shared controls leave native fullscreen transitions with the host that owns them. */
export function mountFullscreenControls(host: PlayerFullscreenHost): {
  refresh(): void;
  destroy(): void;
} {
  const mode = document.querySelector<HTMLSelectElement>('#fullscreen-mode')!;
  const button = document.querySelector<HTMLButtonElement>('#fullscreen')!;
  const help = document.querySelector<HTMLElement>('#fullscreen-help')!;
  function refresh(): void {
    mode.value = host.mode;
    button.textContent =
      host.mode === 'screen'
        ? host.isScreenFullscreen
          ? 'Exit fullscreen'
          : 'Enter fullscreen'
        : host.isExpanded
          ? 'Exit page view'
          : 'Fill page';
    button.setAttribute('aria-pressed', String(host.isExpanded));
    help.hidden = host.mode !== 'screen' || host.isScreenFullscreen;
    help.textContent = host.screenFullscreenAvailable
      ? 'If the game cannot enter fullscreen automatically, press Enter fullscreen.'
      : 'This browser does not offer fullscreen. The game will fill the page.';
  }
  const setMode = () => host.setMode(mode.value === 'screen' ? 'screen' : 'page');
  const toggle = () => host.toggleFullscreen();
  mode.addEventListener('change', setMode);
  button.addEventListener('click', toggle);
  refresh();
  return {
    refresh,
    destroy() {
      mode.removeEventListener('change', setMode);
      button.removeEventListener('click', toggle);
    },
  };
}

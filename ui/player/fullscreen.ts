import type {BrowserFullscreenMode} from '../../src/platform/browser-window-display.js';
import type {BrowserFullscreenScaling} from '../../src/platform/browser-fullscreen.js';

export interface PlayerFullscreenHost {
  readonly mode: BrowserFullscreenMode;
  readonly scaling: BrowserFullscreenScaling;
  readonly isExpanded: boolean;
  readonly isScreenFullscreen: boolean;
  readonly screenFullscreenAvailable: boolean;
  setMode(mode: BrowserFullscreenMode): void;
  setScaling(scaling: BrowserFullscreenScaling): void;
  toggleFullscreen(): void;
}

/** Shared controls leave native fullscreen transitions with the host that owns them. */
export function mountFullscreenControls(host: PlayerFullscreenHost): {
  refresh(): void;
  destroy(): void;
} {
  const mode = document.querySelector<HTMLSelectElement>('#fullscreen-mode')!;
  const button = document.querySelector<HTMLButtonElement>('#fullscreen')!;
  const stretch = document.querySelector<HTMLInputElement>('#fullscreen-stretch')!;
  const help = document.querySelector<HTMLElement>('#fullscreen-help')!;
  function refresh(): void {
    mode.value = host.mode;
    stretch.checked = host.scaling === 'stretch';
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
  const setScaling = () => host.setScaling(stretch.checked ? 'stretch' : 'fit');
  const toggle = () => host.toggleFullscreen();
  mode.addEventListener('change', setMode);
  stretch.addEventListener('change', setScaling);
  button.addEventListener('click', toggle);
  refresh();
  return {
    refresh,
    destroy() {
      mode.removeEventListener('change', setMode);
      stretch.removeEventListener('change', setScaling);
      button.removeEventListener('click', toggle);
    },
  };
}

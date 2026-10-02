import {playerEntry, type PlayerId} from '../players/registry.js';
import {playerSelectionMode, setPlayerSelectionMode} from '../players/detect.js';

/** Behavior bridge for controls rendered by the shared Svelte player shell. */
export function mountGameViewer(game: PlayerId): {collapseOptions(collapsed: boolean): void} {
  const sidebar = document.querySelector<HTMLElement>('#sidebar')!;
  const toggle = document.querySelector<HTMLButtonElement>('#sidebar-toggle')!;
  const body = document.querySelector<HTMLElement>('#sidebar-body')!;
  const gameSelect = document.querySelector<HTMLSelectElement>('#viewer-game')!;

  function collapseOptions(collapsed: boolean): void {
    sidebar.classList.toggle('collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    body.hidden = collapsed;
  }

  const help = document.querySelector<HTMLElement>('#viewer-game-help')!;
  function showMode(): void {
    const auto = playerSelectionMode() === 'auto';
    gameSelect.value = auto ? 'auto' : game;
    help.hidden = !auto;
  }
  showMode();
  gameSelect.addEventListener('change', () => {
    if (gameSelect.value === 'auto') {
      setPlayerSelectionMode('auto');
      showMode();
      return;
    }
    setPlayerSelectionMode('manual');
    const selected = gameSelect.value as PlayerId;
    if (selected === game) return showMode();
    window.location.assign(new URL(playerEntry(selected).route, window.location.href));
  });
  toggle.addEventListener('click', () =>
    collapseOptions(toggle.getAttribute('aria-expanded') === 'true'),
  );
  sidebar.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    collapseOptions(true);
    toggle.focus();
  });

  return {collapseOptions};
}

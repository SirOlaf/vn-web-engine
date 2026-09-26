export type ViewerGame = 'noah' | 'buriko';

/** Behavior bridge for controls rendered by the shared Svelte player shell. */
export function mountGameViewer(game: ViewerGame): {collapseOptions(collapsed: boolean): void} {
  const sidebar = document.querySelector<HTMLElement>('#sidebar')!;
  const toggle = document.querySelector<HTMLButtonElement>('#sidebar-toggle')!;
  const body = document.querySelector<HTMLElement>('#sidebar-body')!;
  const gameSelect = document.querySelector<HTMLSelectElement>('#viewer-game')!;

  function collapseOptions(collapsed: boolean): void {
    sidebar.classList.toggle('collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    body.hidden = collapsed;
  }

  gameSelect.value = game;
  gameSelect.addEventListener('change', () => {
    const destination = gameSelect.value === 'buriko' ? './buriko.html' : './noah.html';
    window.location.assign(new URL(destination, window.location.href));
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

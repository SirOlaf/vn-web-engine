import {subscribeRuntimeAdvisories} from '../platform/runtime-advisories.js';

export type ViewerGame = 'noah' | 'aokana';

/** The common page chrome belongs to the web viewer, outside either native engine. */
export function mountGameViewer(game: ViewerGame): {collapseOptions(collapsed: boolean): void} {
  const sidebar = document.querySelector<HTMLElement>('#sidebar')!;
  const toggle = document.querySelector<HTMLButtonElement>('#sidebar-toggle')!;
  const body = document.querySelector<HTMLElement>('#sidebar-body')!;
  const gameSelect = document.querySelector<HTMLSelectElement>('#viewer-game')!;
  const notices = document.querySelector<HTMLElement>('#runtime-advisories')!;
  const shownAdvisories = new Set<string>();

  function collapseOptions(collapsed: boolean): void {
    sidebar.classList.toggle('collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    body.hidden = collapsed;
  }

  gameSelect.value = game;
  gameSelect.addEventListener('change', () => {
    const destination = gameSelect.value === 'aokana' ? '/aokana.html' : '/';
    window.location.assign(destination);
  });
  toggle.addEventListener('click', () =>
    collapseOptions(toggle.getAttribute('aria-expanded') === 'true'),
  );
  sidebar.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    collapseOptions(true);
    toggle.focus();
  });

  subscribeRuntimeAdvisories((advisory) => {
    if (shownAdvisories.has(advisory.id)) return;
    shownAdvisories.add(advisory.id);
    const card = document.createElement('section');
    card.className = 'runtime-advisory';
    card.dataset.advisoryId = advisory.id;
    const title = document.createElement('strong');
    title.textContent = advisory.title;
    const message = document.createElement('p');
    message.textContent = advisory.message;
    card.append(title, message);
    notices.append(card);
  });

  return {collapseOptions};
}

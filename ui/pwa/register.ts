// All HTML entries live at the deployment root; emitted JS lives under assets/.
// Resolve against the page to retain GitHub Pages project-path scope.
if (import.meta.env.PROD && window.isSecureContext && 'serviceWorker' in navigator) {
  const register = (): void => {
    const root = new URL('./', document.baseURI);
    navigator.serviceWorker
      .register(new URL('sw.js', root), {scope: root.href, updateViaCache: 'none'})
      .then(watchForUpdates)
      .catch((error: unknown) => {
        console.warn(
          'Offline app installation is unavailable; online play is still available.',
          error,
        );
      });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, {once: true});
}

// Browsers only look for a new sw.js on navigation. Long-lived tabs and
// installed app windows also check periodically and when they become visible.
const updateCheckInterval = 30 * 60 * 1000;

/**
 * A controlled page runs the build its service worker cached. A newer build
 * appears as a waiting worker, or as a controller change made by another tab.
 * Either way this page is outdated; the user decides when to reload it.
 */
function watchForUpdates(registration: ServiceWorkerRegistration): void {
  const container = navigator.serviceWorker;
  let lastCheck = Date.now();
  const check = (): void => {
    lastCheck = Date.now();
    registration.update().catch(() => {
      // Offline or the host is unreachable; the cached build keeps working.
    });
  };
  window.setInterval(check, updateCheckInterval);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastCheck > 60_000) check();
  });

  // An uncontrolled page was loaded from the network and is already current.
  if (!container.controller) return;

  let applying = false;
  const notice = new UpdateNotice(() => {
    const waiting = registration.waiting;
    if (!waiting) {
      // Another tab already activated the new build.
      window.location.reload();
      return;
    }
    applying = true;
    waiting.postMessage({type: 'activate-update'});
  });
  const watchInstallation = (worker: ServiceWorker | null): void => {
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed' && registration.waiting === worker) notice.show();
    });
  };
  if (registration.waiting) notice.show();
  watchInstallation(registration.installing);
  registration.addEventListener('updatefound', () => watchInstallation(registration.installing));
  container.addEventListener('controllerchange', () => {
    if (applying) window.location.reload();
    else notice.show();
  });
}

class UpdateNotice {
  private host: HTMLElement | null = null;

  constructor(private readonly reload: () => void) {}

  show(): void {
    if (this.host) return;
    const host = document.createElement('div');
    const shadow = host.attachShadow({mode: 'open'});
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        aside {
          position: fixed;
          right: 16px;
          bottom: 16px;
          z-index: 2147483647;
          box-sizing: border-box;
          max-width: min(360px, calc(100vw - 32px));
          padding: 12px 14px;
          border: 1px solid #2d3b3f;
          border-radius: 8px;
          background: #101518;
          color: #edf3f0;
          box-shadow: 0 8px 24px rgb(0 0 0 / 0.45);
          font: 14px/1.4 Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
        }
        p { margin: 0 0 10px; }
        strong { display: block; margin-bottom: 2px; }
        div { display: flex; gap: 8px; justify-content: flex-end; }
        button {
          font: inherit;
          cursor: pointer;
          padding: 5px 12px;
          border-radius: 6px;
          border: 1px solid #2d3b3f;
          background: transparent;
          color: inherit;
        }
        button.primary { background: #a8e4d1; border-color: #a8e4d1; color: #0b1113; }
        button:focus-visible { outline: 2px solid #a8e4d1; outline-offset: 2px; }
      </style>
      <aside role="status" aria-live="polite">
        <p>
          <strong>Update available</strong>
          A newer version of this site has been published. Reloading closes any running
          game; save first.
        </p>
        <div>
          <button type="button" data-action="later">Later</button>
          <button type="button" class="primary" data-action="reload">Reload</button>
        </div>
      </aside>`;
    shadow.querySelector('[data-action="later"]')!.addEventListener('click', () => this.hide());
    shadow.querySelector('[data-action="reload"]')!.addEventListener('click', (event) => {
      (event.currentTarget as HTMLButtonElement).disabled = true;
      this.reload();
    });
    // Keep game keyboard handlers from seeing presses aimed at the notice.
    shadow.addEventListener('keydown', (event) => event.stopPropagation());
    document.body.append(host);
    this.host = host;
  }

  private hide(): void {
    this.host?.remove();
    this.host = null;
  }
}

// All HTML entries live at the deployment root; emitted JS lives under assets/.
// Resolve against the page to retain GitHub Pages project-path scope.
if (import.meta.env.PROD && window.isSecureContext && 'serviceWorker' in navigator) {
  const register = (): void => {
    const root = new URL('./', document.baseURI);
    void navigator.serviceWorker
      .register(new URL('sw.js', root), {scope: root.href, updateViaCache: 'none'})
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

# Static hosting

The website requires only static files over HTTPS (or loopback HTTP for local development). Players and asset laboratories open game installations selected on the user's device. The host does not need game archives, a game API, Node.js, or writable server storage.

## Build and preview

Use Node.js 24 or newer:

```sh
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:8000/`. The deployable artifact is **`site/` only**. The separate `dist/` directory is for runtime tests and local debug tools. The build first checks the Svelte application, clears and compiles the runtime modules, then bundles the five HTML entries and their dependencies. The codec's required license notices are included in the artifact.

Vite uses a relative base, so the same artifact works at `/`, `/vn-web-engine/`, or another directory without rebuilding. Page links remain relative. JavaScript URLs created relative to `import.meta.url` are bundled as module entries, including workers, AudioWorklets, and the lazily loaded Vorbis decoder. Worklet dependencies are bundled as JavaScript rather than copied as raw source.

To preview a GitHub Pages-style project path:

```sh
STATIC_BASE=/vn-web-engine/ npm start
```

Open `http://127.0.0.1:8000/vn-web-engine/`. This server exposes only the files inside `site/`; installation manifests, archive endpoints, source files, and tools are unavailable.

## GitHub Pages

1. Push the repository with [the Pages workflow](../.github/workflows/pages.yml).
2. In **Settings → Pages → Build and deployment**, select **GitHub Actions** as the source.
3. Push to `main`, or run **Publish static site** manually from the **Actions** tab. If the repository uses another release branch, change the workflow's `push.branches` entry.
4. Open the URL reported by the deployment job. For a project site, it usually ends in `/repository-name/`.

The workflow uploads only `site/`. Keep `targetgame/`, `dist/`, and the repository root out of any alternative hosting upload. The generated `.nojekyll` file also permits copying the artifact to a Pages publishing branch if needed.

No deployment has to run locally. The workflow needs the usual Pages environment and repository Pages permissions. Refer to [GitHub's custom Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) for repository settings.

## Browser storage and HTTPS

Saves, preferences, and retained game files belong to the browser profile and origin. Moving from localhost to GitHub Pages or to a custom domain does not move existing browser data; export saves first and import them at the new address. Paths under the same origin share its storage, so two project sites on the same `owner.github.io` origin are not isolated by repository path.

Game files selected in the browser remain local. Folder permissions may need to be granted again, depending on the browser. IndexedDB or local game-file storage may be evicted under storage pressure; keep exported saves and the original installation. See [mobile compatibility](mobile-compatibility.md) for browser details.

Use HTTPS on remote hosts so AudioWorklet and browser file capabilities are available. GitHub Pages supplies HTTPS. Cross-origin isolation headers are not required by this build.

## Debug streaming

The archive server is retained for local diagnostics:

```sh
npm run build
AOKANA_DATA_ROOT="/path/to/Aokana" npm run start:debug
```

`NOAH_DATA_ROOT` similarly selects a CHAOS;HEAD NOAH installation. Without an override, the debug server looks in `targetgame/aokana/` and `targetgame/chaos-head-noah/`. It serves the built website plus the debug manifests, range endpoints, and `dist/` modules used by tooling. Player and library interfaces use local files; the diagnostic endpoints are accessed explicitly by developer tools.

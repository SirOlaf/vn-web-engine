<script lang="ts">
  import {onMount, tick} from 'svelte';
  import {installationStatus, type GameId, type InstallationStatus} from './library.js';
  import SaveFiles from './player/SaveFiles.svelte';

  const games = {
    buriko: {
      title: 'BGI / Ethornell',
      engine: 'BURIKO',
      route: './buriko.html',
      explorerRoute: './buriko-assets.html',
      initials: 'BG',
    },
    noah: {
      title: 'CHAOS;HEAD NOAH',
      engine: 'MAGES',
      route: './noah.html',
      explorerRoute: './assets.html',
      initials: 'CH',
    },
  } as const;
  let selected: GameId = 'buriko';
  let tab: 'overview' | 'files' = 'overview';
  let installations: Record<GameId, InstallationStatus | null> = {buriko: null, noah: null};
  let checking = false;
  let overviewTab: HTMLButtonElement;
  let filesTab: HTMLButtonElement;

  $: game = games[selected];
  $: installation = installations[selected];

  async function refreshInstallations(): Promise<void> {
    checking = true;
    const [buriko, noah] = await Promise.all([
      installationStatus('buriko'),
      installationStatus('noah'),
    ]);
    installations = {buriko, noah};
    checking = false;
  }

  function chooseGame(id: GameId): void {
    selected = id;
  }

  async function moveTab(event: KeyboardEvent): Promise<void> {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    tab =
      event.key === 'Home'
        ? 'overview'
        : event.key === 'End'
          ? 'files'
          : tab === 'overview'
            ? 'files'
            : 'overview';
    await tick();
    (tab === 'overview' ? overviewTab : filesTab).focus();
  }

  onMount(() => {
    void refreshInstallations();
  });
</script>

<div class="app-shell">
  <header class="topbar">
    <a class="brand" href="./index.html" aria-label="VN Web Engine library">
      <span class="brand-mark" aria-hidden="true">VN</span>
      <span class="brand-copy">WEB ENGINE <small>LIBRARY</small></span>
    </a>
    <div class="topbar-actions">
      <span class="topbar-note">Native Visual Novels running in your Browser</span>
      <a class="github-link" href="https://github.com/SirOlaf/vn-web-engine">GitHub ↗</a>
    </div>
  </header>

  <main>
    <div class="library-layout">
      <section class="shelf" aria-label="Games">
        <div class="section-heading">
          <h2>Library</h2>
          <span>2 players</span>
          <button class="refresh" type="button" onclick={refreshInstallations} disabled={checking}>
            <span aria-hidden="true">↻</span>
            {checking ? 'Checking…' : 'Refresh browser files'}
          </button>
        </div>
        {#each ['buriko', 'noah'] as GameId[] as id}
          <button
            type="button"
            class:selected={selected === id}
            class="game-card"
            aria-pressed={selected === id}
            onclick={() => chooseGame(id)}
          >
            <span class:card-noah={id === 'noah'} class="card-art" aria-hidden="true">
              <span class="card-orbit"></span><span class="card-initials">{games[id].initials}</span
              >
            </span>
            <span class="card-copy">
              <strong>{games[id].title}</strong>
              <span>{games[id].engine} engine</span>
              <small class:ready={installations[id]?.ready}>
                <i aria-hidden="true"></i>
                {installations[id] === null ? 'Checking files' : installations[id]?.label}
              </small>
            </span>
            <span class="card-arrow" aria-hidden="true">›</span>
          </button>
        {/each}
        <p class="shelf-note">
          Game files stay on your device. Choose a folder in the player or keep a browser copy for
          later.
        </p>
      </section>

      <section class="detail" aria-labelledby="detail-title">
        <div class="detail-topline">
          <span>SELECTED PLAYER</span><span class="engine-tag">{game.engine}</span>
        </div>
        <div class="detail-heading">
          <div>
            <h2 id="detail-title">{game.title}</h2>
          </div>
          <span class="detail-monogram" aria-hidden="true">{game.initials}</span>
        </div>
        <div class="detail-tabs" role="tablist" aria-label="Game details">
          <button
            bind:this={overviewTab}
            id="overview-tab"
            type="button"
            role="tab"
            aria-selected={tab === 'overview'}
            aria-controls="game-panel"
            tabindex={tab === 'overview' ? 0 : -1}
            class:active={tab === 'overview'}
            onkeydown={moveTab}
            onclick={() => (tab = 'overview')}>Overview</button
          >
          <button
            bind:this={filesTab}
            id="files-tab"
            type="button"
            role="tab"
            aria-selected={tab === 'files'}
            aria-controls="game-panel"
            tabindex={tab === 'files' ? 0 : -1}
            class:active={tab === 'files'}
            onkeydown={moveTab}
            onclick={() => (tab = 'files')}>Save files</button
          >
        </div>

        {#if tab === 'overview'}
          <div id="game-panel" class="panel" role="tabpanel" aria-labelledby="overview-tab">
            <div class="readiness">
              <span class:ready={installation?.ready} class="readiness-icon" aria-hidden="true"
                >{installation?.ready ? '✓' : '⌁'}</span
              >
              <div>
                <strong
                  >{installation === null
                    ? 'Checking local installation'
                    : installation.label}</strong
                >
                <p>{installation?.detail ?? 'Looking for game files on this device…'}</p>
              </div>
            </div>
            <div class="primary-actions">
              <a class="button primary" href={game.route}>
                Open game
                <span aria-hidden="true">↗</span>
              </a>
              <a class="button secondary" href={game.explorerRoute}>Open asset laboratory</a>
            </div>
            <div class="info-row"><span>Engine</span><strong>{game.engine}</strong></div>
            <div class="info-row"><span>Game files</span><strong>Read locally</strong></div>
            <div class="info-row">
              <span>Saved data</span><strong>Stored in this browser</strong>
            </div>
          </div>
        {:else}
          <div id="game-panel" class="panel save-panel" role="tabpanel" aria-labelledby="files-tab">
            <div class="save-heading">
              <div>
                <h3>Saved data</h3>
                <p>Import or download the game’s local save files.</p>
              </div>
            </div>
            <SaveFiles game={selected} heading={false} />
          </div>
        {/if}
      </section>
    </div>
  </main>

  <footer><span>VN WEB ENGINE</span><span>Local games · Browser saves</span></footer>
</div>

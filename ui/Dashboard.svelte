<script lang="ts">
  import {onMount, tick} from 'svelte';
  import {installationStatus, type InstallationStatus} from './library.js';
  import {PLAYERS, playerEntry, type PlayerEntry, type PlayerId} from './players/registry.js';
  import {detectionMessage, detectPlayers, openInPlayer} from './players/detect.js';
  import {
    hasInstallationDirectoryPicker,
    pickInstallationDirectory,
    selectedInstallationFiles,
    type InstallationSelection,
  } from '../src/platform/installation-picker.js';

  let selected: PlayerId = 'buriko';
  let tab: 'overview' | 'files' = 'overview';
  let installations: Partial<Record<PlayerId, InstallationStatus>> = {};
  let checking = false;
  let overviewTab: HTMLButtonElement;
  let filesTab: HTMLButtonElement;

  $: game = playerEntry(selected);
  $: installation = installations[selected] ?? null;

  async function refreshInstallations(): Promise<void> {
    checking = true;
    const statuses = await Promise.all(PLAYERS.map((entry) => installationStatus(entry)));
    installations = Object.fromEntries(PLAYERS.map((entry, i) => [entry.id, statuses[i]]));
    checking = false;
  }

  let detecting = false;
  let detection = '';
  let matches: readonly PlayerEntry[] = [];
  let folderInput: HTMLInputElement;

  /** Picks a game folder and opens it in the player whose engine markers it carries. */
  function chooseFolder(): void {
    if (detecting) return;
    // The picker call itself happens synchronously in this gesture.
    if (hasInstallationDirectoryPicker(window)) void detect(pickInstallationDirectory(window));
    else folderInput.click();
  }
  function folderChosen(): void {
    const files = Array.from(folderInput.files ?? []);
    folderInput.value = '';
    if (files.length)
      void detect(Promise.resolve().then(() => selectedInstallationFiles(files, true)));
  }
  async function detect(picked: Promise<InstallationSelection>): Promise<void> {
    detecting = true;
    detection = 'Reading the folder…';
    matches = [];
    try {
      const selection = await picked;
      detection = 'Looking for engine markers…';
      const found = await detectPlayers(selection);
      matches = found;
      if (found.length === 1) {
        selected = found[0]!.id;
        tab = 'overview';
      }
      const handedOff = found.length === 1 && (await openInPlayer(found[0]!, selection));
      detection = detectionMessage(found, handedOff);
    } catch (error) {
      detection =
        error instanceof Error && error.name === 'AbortError'
          ? ''
          : error instanceof Error
            ? error.message
            : String(error);
    } finally {
      detecting = false;
    }
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
          <span>{PLAYERS.length} players</span>
          <button class="refresh" type="button" onclick={refreshInstallations} disabled={checking}>
            <span aria-hidden="true">↻</span>
            {checking ? 'Checking…' : 'Refresh browser files'}
          </button>
        </div>
        <div class="auto-detect">
          <button class="button primary" type="button" onclick={chooseFolder} disabled={detecting}>
            Choose game folder
          </button>
          <p>Opens the folder in the player of its engine.</p>
          <input
            bind:this={folderInput}
            type="file"
            webkitdirectory
            hidden
            onchange={folderChosen}
          />
          {#if detection}<p class="auto-detect-status" role="status">{detection}</p>{/if}
          {#if matches.length > 1}
            <div class="auto-detect-matches">
              {#each matches as match (match.id)}
                <a class="button secondary" href={match.route}>{match.title}</a>
              {/each}
            </div>
          {/if}
        </div>
        {#each PLAYERS as entry (entry.id)}
          <button
            type="button"
            class:selected={selected === entry.id}
            class="game-card"
            aria-pressed={selected === entry.id}
            onclick={() => (selected = entry.id)}
          >
            <span class:title-art={entry.art === 'title'} class="card-art" aria-hidden="true">
              <span class="card-orbit"></span><span class="card-initials">{entry.initials}</span>
            </span>
            <span class="card-copy">
              <strong>{entry.title}</strong>
              <span>{entry.summary}</span>
              <small class:ready={installations[entry.id]?.ready}>
                <i aria-hidden="true"></i>
                {installations[entry.id]?.label ?? 'Checking files'}
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
              {#if game.explorerRoute}
                <a class="button secondary" href={game.explorerRoute}>Open asset laboratory</a>
              {/if}
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
            {#await game.saveFiles() then saveFiles}
              <saveFiles.default heading={false} />
            {/await}
          </div>
        {/if}
      </section>
    </div>
  </main>

  <footer><span>VN WEB ENGINE</span><span>Local games · Browser saves</span></footer>
</div>

<script lang="ts">
  import {onMount, tick} from 'svelte';
  import {
    downloadBytes,
    installationStatus,
    noahSaveFiles,
    readNoahSave,
    writeNoahSave,
    type GameId,
    type InstallationStatus,
  } from './library.js';
  import {
    AokanaSaveTransfer,
    type AokanaSaveEntry,
  } from '../src/engines/buriko/games/aokana/save-transfer.js';

  const games = {
    aokana: {
      title: 'Aokana',
      engine: 'BURIKO',
      description: 'Four girls take to the skies in a world where anyone can fly.',
      route: '/aokana.html',
      initials: 'AO',
    },
    noah: {
      title: 'CHAOS;HEAD NOAH',
      engine: 'MAGES',
      description: 'A mystery unfolds in Shibuya through a distinctive visual novel interface.',
      route: '/noah.html',
      initials: 'CH',
    },
  } as const;
  const transfer = new AokanaSaveTransfer();
  let selected: GameId = 'aokana';
  let tab: 'overview' | 'files' = 'overview';
  let installations: Record<GameId, InstallationStatus | null> = {aokana: null, noah: null};
  let checking = false;
  let busy = false;
  let message = '';
  let saveFiles: AokanaSaveEntry[] = [];
  let saveSelection = '';
  let noahSelection: string = noahSaveFiles[0].id;
  let fileInput: HTMLInputElement;
  let overviewTab: HTMLButtonElement;
  let filesTab: HTMLButtonElement;

  $: game = games[selected];
  $: installation = installations[selected];
  $: chosenAokanaSave = saveFiles.find((entry) => `${entry.area}:${entry.path}` === saveSelection);

  async function refreshInstallations(): Promise<void> {
    checking = true;
    const [aokana, noah] = await Promise.all([
      installationStatus('aokana'),
      installationStatus('noah'),
    ]);
    installations = {aokana, noah};
    checking = false;
  }

  async function refreshSaves(): Promise<void> {
    try {
      saveFiles = await transfer.list();
      if (!saveFiles.some((entry) => `${entry.area}:${entry.path}` === saveSelection)) {
        const first = saveFiles[0];
        saveSelection = first ? `${first.area}:${first.path}` : '';
      }
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
  }

  function chooseGame(id: GameId): void {
    selected = id;
    message = '';
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

  function openImport(): void {
    fileInput.value = '';
    fileInput.click();
  }

  async function importFile(): Promise<void> {
    const file = fileInput.files?.[0];
    if (!file || busy) return;
    const targetGame = selected;
    const targetNoahSave = noahSelection;
    const targetAokanaSave = chosenAokanaSave;
    busy = true;
    message = '';
    try {
      if (file.size > 64 * 1024 * 1024) throw new Error('Import exceeds 64 MiB.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (targetGame === 'aokana') {
        const destination =
          targetAokanaSave?.name.toLowerCase() === file.name.toLowerCase()
            ? targetAokanaSave
            : undefined;
        const imported = await transfer.import(file.name, bytes, destination);
        await refreshSaves();
        saveSelection = `${imported.area}:${imported.path}`;
        message = `${imported.name} imported.`;
      } else {
        await writeNoahSave(targetNoahSave, bytes);
        message = `${noahSaveFiles.find((entry) => entry.id === targetNoahSave)?.name} imported.`;
      }
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      fileInput.value = '';
      busy = false;
    }
  }

  async function exportFile(): Promise<void> {
    if (busy) return;
    busy = true;
    message = '';
    try {
      if (selected === 'aokana') {
        if (!chosenAokanaSave) throw new Error('Select a save file.');
        downloadBytes(chosenAokanaSave.name, await transfer.read(chosenAokanaSave));
        message = `${chosenAokanaSave.name} exported.`;
      } else {
        const file = noahSaveFiles.find((entry) => entry.id === noahSelection)!;
        downloadBytes(file.name, await readNoahSave(noahSelection));
        message = `${file.name} exported.`;
      }
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    void refreshInstallations();
    void refreshSaves();
  });
</script>

<svelte:head>
  <meta name="description" content="Open your visual novel library and manage local game files." />
</svelte:head>

<div class="app-shell">
  <header class="topbar">
    <a class="brand" href="/" aria-label="VN Web Engine library">
      <span class="brand-mark" aria-hidden="true">VN</span>
      <span class="brand-copy">WEB ENGINE <small>LIBRARY</small></span>
    </a>
    <span class="topbar-note">Your games, on the web</span>
  </header>

  <main>
    <section class="intro" aria-labelledby="library-title">
      <div>
        <p class="eyebrow">YOUR COLLECTION / 02 GAMES</p>
        <h1 id="library-title">Pick up where your story begins.</h1>
        <p class="intro-copy">
          Open a local installation, choose a game folder, or manage saved data.
        </p>
      </div>
      <button class="refresh" type="button" onclick={refreshInstallations} disabled={checking}>
        <span aria-hidden="true">↻</span>
        {checking ? 'Checking…' : 'Refresh library'}
      </button>
    </section>

    <div class="library-layout">
      <section class="shelf" aria-label="Games">
        <div class="section-heading">
          <h2>Library</h2>
          <span>2 titles</span>
        </div>
        {#each ['aokana', 'noah'] as GameId[] as id}
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
                {installations[id] === null
                  ? 'Checking files'
                  : installations[id]?.ready
                    ? 'Local files ready'
                    : 'Folder needed'}
              </small>
            </span>
            <span class="card-arrow" aria-hidden="true">›</span>
          </button>
        {/each}
        <p class="shelf-note">
          Game files stay on your device. The local server only reads installations you configure.
        </p>
      </section>

      <section class="detail" aria-labelledby="detail-title">
        <div class="detail-topline">
          <span>SELECTED GAME</span><span class="engine-tag">{game.engine}</span>
        </div>
        <div class="detail-heading">
          <div>
            <h2 id="detail-title">{game.title}</h2>
            <p>{game.description}</p>
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
                    : installation.ready
                      ? 'Ready to open'
                      : 'Choose a game folder'}</strong
                >
                <p>{installation?.detail ?? 'Looking for game files on this device…'}</p>
              </div>
            </div>
            <div class="primary-actions">
              <a
                class="button primary"
                href={installation?.ready ? `${game.route}?source=installed` : game.route}
              >
                {installation?.ready ? 'Open installed game' : 'Open game page'}
                <span aria-hidden="true">↗</span>
              </a>
              <a class="button secondary" href={game.route}>Choose folder in player</a>
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
              {#if selected === 'aokana'}<button
                  class="text-button"
                  type="button"
                  onclick={refreshSaves}>Refresh</button
                >{/if}
            </div>
            {#if selected === 'aokana'}
              <label for="aokana-save">File</label>
              <select
                id="aokana-save"
                bind:value={saveSelection}
                disabled={busy || saveFiles.length === 0}
              >
                {#if saveFiles.length === 0}<option value="">No saves yet</option>{/if}
                {#each saveFiles as file}<option value={`${file.area}:${file.path}`}
                    >{file.name} · {file.area === 'game' ? 'Game' : 'User data'} · {Math.ceil(
                      file.size / 1024,
                    )} KB</option
                  >{/each}
              </select>
            {:else}
              <label for="noah-save">File</label>
              <select id="noah-save" bind:value={noahSelection} disabled={busy}>
                {#each noahSaveFiles as file}<option value={file.id}>{file.name}</option>{/each}
              </select>
            {/if}
            <div class="save-actions">
              <button type="button" onclick={openImport} disabled={busy}>Import file</button>
              <button
                type="button"
                onclick={exportFile}
                disabled={busy || (selected === 'aokana' && !chosenAokanaSave)}
                >Export selected</button
              >
            </div>
            <input
              bind:this={fileInput}
              class="visually-hidden"
              type="file"
              accept={selected === 'aokana' ? '.gdb,.cad' : '.dat'}
              onchange={importFile}
              aria-label="Choose a save file to import"
            />
            <p class="help">
              Close the player before importing so the game does not overwrite the imported file.
            </p>
            <p class="action-message" role="status">{message}</p>
          </div>
        {/if}
      </section>
    </div>
  </main>

  <footer><span>VN WEB ENGINE</span><span>Local games · Browser saves</span></footer>
</div>

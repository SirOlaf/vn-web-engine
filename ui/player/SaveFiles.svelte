<script lang="ts">
  import {onMount} from 'svelte';
  import {
    BurikoSaveTransfer,
    type BurikoSaveEntry,
  } from '../../src/engines/buriko/save-transfer.js';
  import {burikoRegistryFold} from '../../src/engines/buriko/native/registry-case.js';
  import {
    downloadBytes,
    noahSaveFiles,
    readNoahSave,
    writeNoahSave,
    type GameId,
  } from '../library.js';
  import {playerRuntimeState, setSaveBusy} from './runtime-state.js';
  import {IndexedDbStore} from '../../src/platform/store.js';
  import {
    activeBurikoGame,
    burikoSavedGames,
    loadBurikoSavedGames,
    type BurikoSavedGame,
  } from './buriko-library.js';

  export let game: GameId;
  export let runtime = false;
  export let heading = true;
  let savedGameId = '';
  $: if (!savedGameId && $burikoSavedGames[0]) savedGameId = $burikoSavedGames[0].id;
  let previousSavedGameId: string | undefined;
  $: savedGame = runtime
    ? $activeBurikoGame
    : $burikoSavedGames.find((entry) => entry.id === savedGameId);
  function transferFor(game: BurikoSavedGame): BurikoSaveTransfer {
    const namespace = [...game.namespace];
    return new BurikoSaveTransfer((area) => IndexedDbStore.open([...namespace, area]));
  }
  $: transfer = savedGame ? transferFor(savedGame) : null;
  $: if (game === 'buriko' && savedGame?.id !== previousSavedGameId) {
    previousSavedGameId = savedGame?.id;
    void refresh().catch((error) => {
      message = error instanceof Error ? error.message : String(error);
    });
  }
  let entries: BurikoSaveEntry[] = [];
  let selection = '';
  let noahSelection: string = noahSaveFiles[0].id;
  let busy = false;
  let message = '';
  let input: HTMLInputElement;
  let revision = 0;
  let wasRunning = false;
  $: if (runtime) {
    if (wasRunning && !$playerRuntimeState.running) {
      void refresh().catch((error) => {
        message = error instanceof Error ? error.message : String(error);
      });
    }
    wasRunning = $playerRuntimeState.running;
  }
  $: selected = entries.find((entry) => `${entry.area}:${entry.path}` === selection);
  $: locked = busy || (runtime && $playerRuntimeState.busy) || (game === 'buriko' && !savedGame);
  $: importLocked = locked || (runtime && $playerRuntimeState.running);

  async function refresh(prefer?: BurikoSaveEntry): Promise<void> {
    const current = ++revision;
    const found = transfer ? await transfer.list() : [];
    if (current !== revision) return;
    entries = found;
    if (prefer) selection = `${prefer.area}:${prefer.path}`;
    if (!entries.some((entry) => `${entry.area}:${entry.path}` === selection)) {
      const first = entries[0];
      selection = first ? `${first.area}:${first.path}` : '';
    }
  }

  async function action(work: () => Promise<void>): Promise<void> {
    if (locked) return;
    busy = true;
    if (runtime) setSaveBusy(true);
    message = '';
    try {
      await work();
    } catch (error) {
      message =
        error instanceof Error && 'code' in error && error.code === 'NOT_FOUND'
          ? 'This file has not been saved yet.'
          : error instanceof Error
            ? error.message
            : String(error);
    } finally {
      busy = false;
      if (runtime) setSaveBusy(false);
    }
  }

  function importFile(): void {
    const file = input.files?.[0];
    input.value = '';
    if (!file || importLocked) return;
    const targetGame = game;
    const targetTransfer = transfer;
    const targetSave = selected;
    const targetNoahSave = noahSelection;
    void action(async () => {
      if (file.size > 64 * 1024 * 1024) throw new Error('Import exceeds 64 MiB.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (targetGame === 'buriko') {
        if (!targetTransfer) throw new Error('Choose a BGI installation first.');
        const destination =
          targetSave && burikoRegistryFold(targetSave.name) === burikoRegistryFold(file.name)
            ? targetSave
            : undefined;
        const entry = await targetTransfer.import(file.name, bytes, destination);
        await refresh(entry);
        message = `${entry.name} imported into browser ${entry.area} data.`;
      } else {
        await writeNoahSave(targetNoahSave, bytes);
        message = `${noahSaveFiles.find((entry) => entry.id === targetNoahSave)?.name} imported.`;
      }
    });
  }

  function exportFile(): void {
    const targetGame = game;
    const targetTransfer = transfer;
    const targetSave = selected;
    const targetNoahSave = noahSelection;
    void action(async () => {
      if (targetGame === 'buriko') {
        if (!targetTransfer) throw new Error('Choose a BGI installation first.');
        if (!targetSave) throw new Error('Select a save file.');
        downloadBytes(targetSave.name, await targetTransfer.read(targetSave));
        message = `${targetSave.name} exported.`;
      } else {
        const file = noahSaveFiles.find((entry) => entry.id === targetNoahSave)!;
        downloadBytes(file.name, await readNoahSave(targetNoahSave));
        message = `${file.name} exported.`;
      }
    });
  }

  onMount(() => {
    const update = () =>
      void refresh().catch((error) => {
        message = error instanceof Error ? error.message : String(error);
      });
    void loadBurikoSavedGames()
      .then(update)
      .catch((error) => {
        message = error instanceof Error ? error.message : String(error);
      });
    window.addEventListener('focus', update);
    return () => window.removeEventListener('focus', update);
  });
</script>

<section id="save-files" class="save-controls">
  {#if heading}<h2>Save files</h2>{/if}
  {#if game === 'buriko'}
    {#if runtime}
      <p>{savedGame ? savedGame.title : 'Choose a game installation to access its saves.'}</p>
    {:else}
      <label for="save-game">Installation</label>
      <select id="save-game" bind:value={savedGameId} disabled={busy}>
        {#each $burikoSavedGames as entry (entry.id)}
          <option value={entry.id}>{entry.title}</option>
        {/each}
      </select>
    {/if}
  {/if}
  <label for="save-file">Saved in this browser</label>
  {#if game === 'buriko'}
    <select id="save-file" bind:value={selection} disabled={locked || entries.length === 0}>
      {#if entries.length === 0}<option value="">No browser saves yet</option>{/if}
      {#each entries as entry (`${entry.area}:${entry.path}`)}
        <option value={`${entry.area}:${entry.path}`}
          >{entry.name} · {entry.area === 'game' ? 'Game data' : 'User data'}</option
        >
      {/each}
    </select>
  {:else}
    <select id="save-file" bind:value={noahSelection} disabled={locked}>
      {#each noahSaveFiles as file}<option value={file.id}>{file.name}</option>{/each}
    </select>
  {/if}
  <div class="file-actions">
    <button id="save-import" type="button" onclick={() => input.click()} disabled={importLocked}
      >Import</button
    >
    <button
      id="save-export"
      type="button"
      onclick={exportFile}
      disabled={locked || (game === 'buriko' && !selected)}>Export</button
    >
  </div>
  <input
    id="save-import-file"
    bind:this={input}
    type="file"
    accept={game === 'buriko' ? '.gdb,.cad' : '.dat'}
    onchange={importFile}
    hidden
  />
  <p id="save-status" role="status">{message}</p>
</section>

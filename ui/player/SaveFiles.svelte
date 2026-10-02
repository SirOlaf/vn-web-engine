<script lang="ts">
  import {onMount, untrack, type Snippet} from 'svelte';
  import {downloadBytes} from '../library.js';
  import {playerRuntimeState, setSaveBusy} from './runtime-state.js';
  import type {SaveFileEntry, SaveFilesAdapter} from './save-files.js';

  let {
    adapter,
    runtime = false,
    heading = true,
    scope,
  }: {
    adapter: SaveFilesAdapter;
    /** In the player: follows the running game and waits while it saves. */
    runtime?: boolean;
    heading?: boolean;
    /** The game whose saves are shown, above the file list. */
    scope?: Snippet<[{busy: boolean}]>;
  } = $props();

  let entries: readonly SaveFileEntry[] = $state([]);
  let selection = $state('');
  let busy = $state(false);
  let message = $state('');
  let input: HTMLInputElement;
  let revision = 0;

  const locked = $derived(
    busy || (runtime && $playerRuntimeState.busy) || adapter.unavailable !== null,
  );
  const importLocked = $derived(locked || (runtime && $playerRuntimeState.running));

  async function refresh(target = adapter, prefer?: string | null): Promise<void> {
    const current = ++revision;
    const found = target.unavailable === null ? await target.list() : [];
    if (current !== revision) return;
    entries = found;
    if (prefer) selection = prefer;
    if (!entries.some((entry) => entry.id === selection)) selection = entries[0]?.id ?? '';
  }
  function report(error: unknown): void {
    message = error instanceof Error ? error.message : String(error);
  }

  // Refreshes follow the adapter only, not the list state they write.
  $effect(() => {
    const target = adapter;
    untrack(() => void refresh(target).catch(report));
  });
  let wasRunning = false;
  $effect(() => {
    const running = $playerRuntimeState.running;
    if (runtime && wasRunning && !running) untrack(() => void refresh().catch(report));
    wasRunning = running;
  });

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
    const target = adapter,
      selected = selection || null;
    void action(async () => {
      if (file.size > 64 * 1024 * 1024) throw new Error('Import exceeds 64 MiB.');
      const result = await target.import(
        file.name,
        new Uint8Array(await file.arrayBuffer()),
        selected,
      );
      await refresh(target, result.id);
      message = result.message;
    });
  }

  function exportFile(): void {
    const target = adapter,
      selected = selection;
    void action(async () => {
      if (!selected) throw new Error('Select a save file.');
      const {name, bytes} = await target.read(selected);
      downloadBytes(name, bytes);
      message = `${name} exported.`;
    });
  }

  onMount(() => {
    const update = () => void refresh().catch(report);
    window.addEventListener('focus', update);
    return () => window.removeEventListener('focus', update);
  });
</script>

<section id="save-files" class="save-controls">
  {#if heading}<h2>Save files</h2>{/if}
  {@render scope?.({busy})}
  <label for="save-file">Saved in this browser</label>
  {#if adapter.unavailable !== null}<p>{adapter.unavailable}</p>{/if}
  <select
    id="save-file"
    bind:value={selection}
    disabled={locked || (adapter.emptyLabel !== null && entries.length === 0)}
  >
    {#if entries.length === 0 && adapter.emptyLabel !== null}
      <option value="">{adapter.emptyLabel}</option>
    {/if}
    {#each entries as entry (entry.id)}<option value={entry.id}>{entry.label}</option>{/each}
  </select>
  <div class="file-actions">
    <button id="save-import" type="button" onclick={() => input.click()} disabled={importLocked}
      >Import</button
    >
    <button id="save-export" type="button" onclick={exportFile} disabled={locked || !selection}
      >Export</button
    >
  </div>
  <input
    id="save-import-file"
    bind:this={input}
    type="file"
    accept={adapter.accept}
    onchange={importFile}
    hidden
  />
  <p id="save-status" role="status">{message}</p>
</section>

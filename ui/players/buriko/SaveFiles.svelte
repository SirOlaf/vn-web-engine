<script lang="ts">
  import {onMount} from 'svelte';
  import SaveFiles from '../../player/SaveFiles.svelte';
  import {
    activeBurikoGame,
    burikoSavedGames,
    loadBurikoSavedGames,
  } from '../../player/buriko-library.js';
  import {burikoSaveFiles} from './save-files.js';

  let {runtime = false, heading = true}: {runtime?: boolean; heading?: boolean} = $props();
  let chosen = $state('');
  $effect(() => {
    if (!chosen && $burikoSavedGames[0]) chosen = $burikoSavedGames[0].id;
  });
  const game = $derived(
    runtime ? $activeBurikoGame : ($burikoSavedGames.find((entry) => entry.id === chosen) ?? null),
  );
  const adapter = $derived(burikoSaveFiles(game, runtime));
  onMount(() => void loadBurikoSavedGames().catch(() => undefined));
</script>

<SaveFiles {adapter} {runtime} {heading}>
  {#snippet scope({busy})}
    {#if runtime}
      {#if game}<p>{game.title}</p>{/if}
    {:else}
      <label for="save-game">Installation</label>
      <select id="save-game" bind:value={chosen} disabled={busy}>
        {#each $burikoSavedGames as entry (entry.id)}
          <option value={entry.id}>{entry.title}</option>
        {/each}
      </select>
    {/if}
  {/snippet}
</SaveFiles>

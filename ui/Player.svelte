<script lang="ts">
  import {onMount} from 'svelte';
  import type {GameId} from './library.js';
  import Sidebar from './player/Sidebar.svelte';
  import RuntimeNotices from './player/RuntimeNotices.svelte';
  import SourceActivity from './player/SourceActivity.svelte';
  export let game: GameId;
  $: title = game === 'aokana' ? 'Aokana' : 'CHAOS;HEAD NOAH';

  onMount(() => {
    const boot = game === 'aokana' ? import('./runtimes/aokana.js') : import('./runtimes/noah.js');
    void boot.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const fatal = document.getElementById('fatal-error')!;
      fatal.textContent = `Unable to start the player: ${message}`;
      fatal.hidden = false;
    });
  });
</script>

<svelte:head><title>{title} · VN Web Engine</title></svelte:head>

<main id="game" aria-label="Game">
  <section id="display" aria-label={`${title} display`}>
    {#if game === 'aokana'}
      <div id="display-viewport">
        <div id="surface"><canvas id="game-canvas" tabindex="0"></canvas></div>
        <div id="window-layer"></div>
      </div>
    {:else}
      <div id="noah-surface"></div>
    {/if}
    <div id="welcome">
      <span class="eyebrow">VN / WEB ENGINE</span>
      <h1 id="game-title">{title}</h1>
      <p id="prompt">Choose your game folder or open game files saved in this browser.</p>
      <p class="touch-help">
        Tap to click · Drag to move · Hold or press with two fingers to right-click
      </p>
      <p id="fatal-error" role="alert" hidden></p>
      <button id="play" type="button" disabled>Play</button>
    </div>
    <Sidebar {game} />
    <RuntimeNotices />
    <SourceActivity />
  </section>
</main>

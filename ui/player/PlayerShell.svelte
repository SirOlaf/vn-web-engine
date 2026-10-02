<script lang="ts">
  import {onMount, type Snippet} from 'svelte';
  import type {PlayerEntry} from '../players/registry.js';
  import Sidebar from './Sidebar.svelte';
  import RuntimeNotices from './RuntimeNotices.svelte';
  import SourceActivity from './SourceActivity.svelte';
  import {playerRuntimeState} from './runtime-state.js';

  let {
    entry,
    title = entry.title,
    surface,
    textHelp,
    saveFiles,
    options,
    boot,
  }: {
    entry: PlayerEntry;
    /** The page title; a player may name the game it opened. */
    title?: string;
    /** The game display the runtime draws into. */
    surface: Snippet;
    /** What DOM text does in this player. */
    textHelp: Snippet;
    saveFiles: Snippet;
    /** Further sidebar sections of the player. */
    options?: Snippet;
    /** Starts the player's runtime controller once the shell is in the document. */
    boot: () => Promise<unknown>;
  } = $props();

  onMount(() => {
    const warnBeforeClosing = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = true;
    };
    const unsubscribe = playerRuntimeState.subscribe(({running, saveBusy}) => {
      if (running || saveBusy) window.addEventListener('beforeunload', warnBeforeClosing);
      else window.removeEventListener('beforeunload', warnBeforeClosing);
    });
    void boot().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const fatal = document.getElementById('fatal-error')!;
      fatal.textContent = `Unable to start the player: ${message}`;
      fatal.hidden = false;
    });
    return () => {
      unsubscribe();
      window.removeEventListener('beforeunload', warnBeforeClosing);
    };
  });
</script>

<svelte:head><title>{title} · VN Web Engine</title></svelte:head>

<main id="game" aria-label="Game">
  <section id="display" aria-label={`${title} display`}>
    {@render surface()}
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
    <Sidebar {entry} {textHelp} {saveFiles} {options} />
    <RuntimeNotices />
    <SourceActivity />
  </section>
</main>

<script lang="ts">
  import type {Snippet} from 'svelte';
  import {PLAYERS, type PlayerEntry} from '../players/registry.js';
  import InstallationFiles from './InstallationFiles.svelte';
  import AudioDiagnostics from './AudioDiagnostics.svelte';
  import PerformanceDiagnostics from './PerformanceDiagnostics.svelte';
  import DomTextStyle from './DomTextStyle.svelte';

  let {
    entry,
    textHelp,
    saveFiles,
    options,
  }: {entry: PlayerEntry; textHelp: Snippet; saveFiles: Snippet; options?: Snippet} = $props();
</script>

<aside id="sidebar" aria-label="Game options">
  <button
    id="sidebar-toggle"
    type="button"
    aria-expanded="true"
    aria-controls="sidebar-body"
    aria-label="Toggle game options"
  >
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="2.5" y="3.5" width="15" height="13" rx="2" stroke="currentColor" />
      <path d="M8 4v12" stroke="currentColor" />
    </svg><span>Game options</span>
  </button>
  <div id="sidebar-body">
    <p id="status" role="status">No game loaded.</p>
    <section>
      <h2>Game</h2>
      <a class="sidebar-library-link" href="./">← Library</a>
      <label for="viewer-game">Select player</label>
      <select id="viewer-game" value={entry.id}>
        {#each PLAYERS as player (player.id)}<option value={player.id}>{player.title}</option
          >{/each}
      </select>
    </section>
    <section>
      <h2>Display</h2>
      <label for="fullscreen-mode">Fullscreen behavior</label>
      <select id="fullscreen-mode">
        <option value="page">Fill browser page</option><option value="screen"
          >True fullscreen</option
        >
      </select>
      <label class="fullscreen-stretch">
        <input id="fullscreen-stretch" type="checkbox" />
        Stretch to fill the screen
      </label>
      <button id="fullscreen" type="button" aria-pressed="false" aria-describedby="fullscreen-help"
        >Fill page</button
      >
      <p id="fullscreen-help" role="status" hidden></p>
    </section>
    <InstallationFiles />
    <section>
      <h2>Text rendering</h2>
      <label class="sr-only" for="text-mode">Text rendering mode</label>
      <select id="text-mode" aria-describedby="text-help">
        <option value="native">Native</option><option value="dom">DOM text</option>
      </select>
      <p id="text-help">{@render textHelp()}</p>
      <DomTextStyle />
    </section>
    {@render saveFiles()}
    {@render options?.()}
    <AudioDiagnostics />
    <PerformanceDiagnostics />
  </div>
</aside>

<style>
  .fullscreen-stretch {
    display: flex;
    align-items: center;
    gap: 8px;
  }
</style>

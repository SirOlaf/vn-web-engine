<script lang="ts">
  import type {GameId} from '../library.js';
  import InstallationFiles from './InstallationFiles.svelte';
  import SaveFiles from './SaveFiles.svelte';
  import AudioDiagnostics from './AudioDiagnostics.svelte';
  export let game: GameId;
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
    <section>
      <h2>Game</h2>
      <a class="sidebar-library-link" href="./">← Library</a>
      <label for="viewer-game">Select game</label>
      <select id="viewer-game" value={game}>
        <option value="noah">CHAOS;HEAD NOAH</option><option value="aokana">Aokana</option>
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
      <button id="fullscreen" type="button" aria-pressed="false" aria-describedby="fullscreen-help"
        >Fill page</button
      >
      <p id="fullscreen-help" role="status" hidden></p>
    </section>
    <InstallationFiles />
    <SaveFiles {game} runtime />
    {#if game === 'noah'}
      <section>
        <h2>Text rendering</h2>
        <label class="sr-only" for="text-mode">Text rendering mode</label>
        <select id="text-mode" aria-describedby="text-help">
          <option value="native">Native</option><option value="dom">DOM text</option>
        </select>
        <p id="text-help">
          DOM text uses selectable browser fonts with the game’s line breaks. Click outside text to
          control the game.
        </p>
      </section>
    {:else}
      <section id="playback-options" hidden>
        <h2>Playback</h2>
        <button id="skip-startup" type="button" aria-pressed="false" disabled hidden
          >Skip startup sequence</button
        >
      </section>
    {/if}
    <p id="status" role="status">No game loaded.</p>
    <AudioDiagnostics />
  </div>
</aside>

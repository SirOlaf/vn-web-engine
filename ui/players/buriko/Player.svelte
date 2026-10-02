<script lang="ts">
  import PlayerShell from '../../player/PlayerShell.svelte';
  import RuntimeProfile from '../../player/RuntimeProfile.svelte';
  import BitmapMemory from '../../player/BitmapMemory.svelte';
  import {burikoTitle} from '../../player/buriko-library.js';
  import {playerEntry} from '../registry.js';
  import SaveFiles from './SaveFiles.svelte';
</script>

<PlayerShell
  entry={playerEntry('buriko')}
  title={$burikoTitle}
  boot={() => import('../../runtimes/buriko.js')}
>
  {#snippet surface()}
    <div id="display-viewport">
      <div id="surface"><canvas id="game-canvas" tabindex="0"></canvas></div>
      <div id="window-layer"></div>
    </div>
  {/snippet}
  {#snippet textHelp()}
    DOM text uses selectable browser fonts with the game’s line breaks. Glyph placement and visual
    effects are approximate.
  {/snippet}
  {#snippet saveFiles()}<SaveFiles runtime />{/snippet}
  {#snippet options()}
    <RuntimeProfile />
    <BitmapMemory />
    <section id="playback-options" hidden>
      <h2>Playback</h2>
      <button id="skip-startup" type="button" aria-pressed="false" disabled hidden
        >Skip startup sequence</button
      >
    </section>
  {/snippet}
</PlayerShell>

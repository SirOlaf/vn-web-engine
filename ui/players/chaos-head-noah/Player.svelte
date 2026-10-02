<script lang="ts">
  import PlayerShell from '../../player/PlayerShell.svelte';
  import {playerEntry} from '../registry.js';
  import SaveFiles from './SaveFiles.svelte';
</script>

<PlayerShell entry={playerEntry('chaos-head-noah')} boot={() => import('../../runtimes/noah.js')}>
  {#snippet surface()}<div id="noah-surface"></div>{/snippet}
  {#snippet textHelp()}
    DOM text uses selectable browser fonts with the game’s line breaks. Glyph placement and visual
    effects are approximate.
  {/snippet}
  {#snippet saveFiles()}<SaveFiles runtime />{/snippet}
</PlayerShell>

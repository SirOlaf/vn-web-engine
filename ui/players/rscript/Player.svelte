<script lang="ts">
  import PlayerShell from '../../player/PlayerShell.svelte';
  import {playerEntry} from '../registry.js';
  import SaveFiles from './SaveFiles.svelte';
</script>

<PlayerShell entry={playerEntry('rscript')} boot={() => import('../../runtimes/rscript.js')}>
  {#snippet surface()}<div id="rscript-surface"></div>{/snippet}
  {#snippet textHelp()}
    DOM text places selectable text over the game’s own text for copying and dictionary extensions;
    a custom style shows it in your font instead. Click outside the text to continue; Shift is left
    to the extension.
  {/snippet}
  {#snippet saveFiles()}<SaveFiles runtime />{/snippet}
</PlayerShell>

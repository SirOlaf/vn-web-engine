<script lang="ts">
  import PlayerShell from '../../player/PlayerShell.svelte';
  import {playerEntry} from '../registry.js';
  import SaveFiles from './SaveFiles.svelte';
</script>

<PlayerShell entry={playerEntry('artemis')} boot={() => import('../../runtimes/artemis.js')}>
  {#snippet surface()}<div id="artemis-surface"></div>{/snippet}
  {#snippet textHelp()}
    DOM text places selectable text over the game’s own text for copying and dictionary extensions;
    a custom style shows it in your font instead. A click on the text still reaches the game unless
    it selects text; Shift is left to the extension.
  {/snippet}
  {#snippet saveFiles()}<SaveFiles runtime />{/snippet}
</PlayerShell>

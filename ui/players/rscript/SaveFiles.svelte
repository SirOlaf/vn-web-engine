<script lang="ts">
  import SaveFiles from '../../player/SaveFiles.svelte';
  import {activeRScriptGame} from '../../player/rscript-library.js';
  import {rscriptSaveFiles} from './save-files.js';

  let {runtime = false, heading = true}: {runtime?: boolean; heading?: boolean} = $props();
  const adapter = $derived(rscriptSaveFiles($activeRScriptGame));
</script>

<SaveFiles {adapter} {runtime} {heading} />

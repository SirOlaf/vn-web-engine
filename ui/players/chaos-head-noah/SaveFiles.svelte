<script lang="ts">
  import SaveFiles from '../../player/SaveFiles.svelte';
  import {noahSaveFileAdapter} from './save-files.js';

  let {runtime = false, heading = true}: {runtime?: boolean; heading?: boolean} = $props();
  const adapter = noahSaveFileAdapter();
</script>

<SaveFiles {adapter} {runtime} {heading} />

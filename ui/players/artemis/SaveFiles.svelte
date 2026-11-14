<script lang="ts">
  import SaveFiles from '../../player/SaveFiles.svelte';
  import {activeArtemisGame} from '../../player/artemis-library.js';
  import {artemisSaveFiles} from './save-files.js';

  let {runtime = false, heading = true}: {runtime?: boolean; heading?: boolean} = $props();
  const adapter = $derived(artemisSaveFiles($activeArtemisGame));
</script>

<SaveFiles {adapter} {runtime} {heading} />

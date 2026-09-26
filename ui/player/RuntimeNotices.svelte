<script lang="ts">
  import {onMount} from 'svelte';
  import {
    subscribeRuntimeAdvisories,
    type RuntimeAdvisory,
  } from '../../src/platform/runtime-advisories.js';
  import {audioControls, resumeBrowserAudio} from './browser-audio-controls.js';
  import MediaActivation from './MediaActivation.svelte';

  let advisories: RuntimeAdvisory[] = [];
  onMount(() =>
    subscribeRuntimeAdvisories((advisory) => {
      if (!advisories.some(({id}) => id === advisory.id)) advisories = [...advisories, advisory];
    }),
  );
</script>

<div id="runtime-advisories" class="runtime-advisories" aria-live="polite">
  <section class="runtime-advisory runtime-audio-recovery" hidden={!$audioControls.needsResume}>
    <strong>Audio paused by browser</strong>
    <p>Resume audio to continue playback.</p>
    <button type="button" onclick={resumeBrowserAudio}>Resume audio</button>
    <p role="status">{$audioControls.failure}</p>
  </section>
  {#each advisories as advisory (advisory.id)}
    <section class="runtime-advisory" data-advisory-id={advisory.id}>
      <strong>{advisory.title}</strong>
      <p>{advisory.message}</p>
    </section>
  {/each}
</div>
<MediaActivation />

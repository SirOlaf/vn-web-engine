<script lang="ts">
  import {onMount} from 'svelte';
  import {
    subscribeBrowserMediaActivation,
    type BrowserMediaActivationRequest,
  } from '../../src/video/browser-media-activation.js';
  import MediaActivationPrompt from './MediaActivationPrompt.svelte';
  let requests: readonly BrowserMediaActivationRequest[] = [];
  onMount(() =>
    subscribeBrowserMediaActivation(document, (value) => {
      requests = value;
    }),
  );
</script>

{#each requests as request (request.id)}<MediaActivationPrompt {request} />{/each}

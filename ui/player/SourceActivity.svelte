<script lang="ts">
  import {onMount} from 'svelte';
  import {subscribePlayerActivity} from './source-activity.js';
  let state = {hidden: true, label: ''};
  onMount(() =>
    subscribePlayerActivity((value) => {
      state = value;
    }),
  );
</script>

<div class="source-activity" role="status" hidden={state.hidden}>{state.label}</div>

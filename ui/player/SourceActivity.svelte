<script lang="ts">
  import {onDestroy} from 'svelte';
  import {subscribePlayerActivity} from './source-activity.js';
  import {loadingIndicatorShown} from './loading-indicator.js';
  let state = {hidden: true, label: ''};
  let unsubscribe: (() => void) | undefined;
  // Observe activity only while the indicator is enabled, so a hidden indicator keeps no timers.
  const unsubscribeSetting = loadingIndicatorShown.subscribe((shown) => {
    unsubscribe?.();
    unsubscribe = undefined;
    state = {hidden: true, label: ''};
    if (shown)
      unsubscribe = subscribePlayerActivity((value) => {
        state = value;
      });
  });
  onDestroy(() => {
    unsubscribeSetting();
    unsubscribe?.();
  });
</script>

<div class="source-activity" role="status" hidden={state.hidden}>{state.label}</div>

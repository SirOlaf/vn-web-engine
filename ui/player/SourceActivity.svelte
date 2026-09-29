<script lang="ts">
  import {onDestroy} from 'svelte';
  import {subscribePlayerActivity} from './source-activity.js';
  import {loadingIndicatorShown} from './loading-indicator.js';
  let state = {hidden: true, label: ''};
  let unsubscribe: (() => void) | undefined;
  // A hidden indicator still reports essential activities, such as a first-run font scan
  // that would otherwise look like a frozen game; it keeps timers only while one is pending.
  const unsubscribeSetting = loadingIndicatorShown.subscribe((shown) => {
    unsubscribe?.();
    state = {hidden: true, label: ''};
    unsubscribe = subscribePlayerActivity(
      (value) => {
        state = value;
      },
      {essentialOnly: !shown},
    );
  });
  onDestroy(() => {
    unsubscribeSetting();
    unsubscribe?.();
  });
</script>

<div class="source-activity" role="status" hidden={state.hidden}>{state.label}</div>

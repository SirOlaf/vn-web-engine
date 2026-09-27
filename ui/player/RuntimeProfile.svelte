<script lang="ts">
  import {onMount} from 'svelte';
  import {
    getRuntimeProfile,
    setRuntimeProfile,
    subscribeRuntimeProfile,
  } from '../../src/platform/runtime-profile.js';

  const storageKey = 'vn-web-engine.runtime-profile';
  let profile = getRuntimeProfile();

  onMount(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved === 'native' || saved === 'browser-optimized') setRuntimeProfile(saved);
    } catch {
      /* Profile selection also works when browser storage is unavailable. */
    }
    return subscribeRuntimeProfile((value) => {
      profile = value;
    });
  });

  function changeProfile(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (value !== 'native' && value !== 'browser-optimized') return;
    setRuntimeProfile(value);
    try {
      localStorage.setItem(storageKey, value);
    } catch {
      /* Keep the live selection even when it cannot be remembered. */
    }
  }
</script>

<section>
  <h2>Runtime</h2>
  <label for="runtime-profile">Runtime profile</label>
  <select
    id="runtime-profile"
    value={profile}
    onchange={changeProfile}
    aria-describedby="runtime-profile-help"
  >
    <option value="native">Native</option>
    <option value="browser-optimized">Browser optimized</option>
  </select>
  <p id="runtime-profile-help">
    Browser optimized favors smoother frame updates and may change background completion timing and
    image rounding. Native preserves the original behavior. Changes apply on the next game update
    without restarting.
  </p>
</section>

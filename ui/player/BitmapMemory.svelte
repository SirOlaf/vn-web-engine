<script lang="ts">
  import {onMount} from 'svelte';
  import {
    burikoResidentBitmapBudget,
    setBurikoBitmapResidencyEnabled,
    setBurikoResidentBitmapBudget,
  } from '../../src/engines/buriko/native/bitmap-resident.js';

  const storageKey = 'vn-web-engine.bitmap-memory';
  const MIB = 1024 * 1024;
  const choices = ['auto', '128', '256', '384', '512', 'off'] as const;
  type Choice = (typeof choices)[number];
  const automaticMiB = burikoResidentBitmapBudget() / MIB;
  let choice: Choice = 'auto';
  let pending = false;

  /** Returns whether the choice reaches the resident heap before it is reserved. */
  function apply(value: Choice): boolean {
    setBurikoBitmapResidencyEnabled(value !== 'off');
    return setBurikoResidentBitmapBudget(
      value === 'auto' || value === 'off' ? null : Number(value) * MIB,
    );
  }

  onMount(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if ((choices as readonly string[]).includes(saved ?? '')) choice = saved as Choice;
    } catch {
      /* The automatic budget applies when browser storage is unavailable. */
    }
    apply(choice);
  });

  function changeChoice(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value as Choice;
    if (!choices.includes(value)) return;
    choice = value;
    pending = !apply(value);
    try {
      localStorage.setItem(storageKey, value);
    } catch {
      /* Keep the live selection even when it cannot be remembered. */
    }
  }
</script>

<details id="bitmap-memory-options">
  <summary>Advanced memory</summary>
  <label for="bitmap-memory">Resident bitmap memory</label>
  <select
    id="bitmap-memory"
    value={choice}
    onchange={changeChoice}
    aria-describedby="bitmap-memory-help"
  >
    <option value="auto">Automatic ({automaticMiB} MiB)</option>
    <option value="128">128 MiB</option>
    <option value="256">256 MiB</option>
    <option value="384">384 MiB</option>
    <option value="512">512 MiB</option>
    <option value="off">Off</option>
  </select>
  <p id="bitmap-memory-help">
    Bitmaps kept in WebAssembly memory draw without per-frame copies. A larger budget keeps more of
    them there; the memory is reserved when a game starts and stays in use until the page closes.
    Bitmaps that do not fit, or all bitmaps when off, use ordinary memory at lower speed.
  </p>
  {#if pending}
    <p role="status">Reload the page to apply this change.</p>
  {/if}
</details>

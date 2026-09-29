<script lang="ts">
  import {onMount} from 'svelte';
  import {
    getRuntimePerformanceSnapshot,
    getRuntimePerformanceStatus,
    startRuntimePerformanceRecording,
    stopRuntimePerformanceRecording,
    subscribeRuntimePerformance,
  } from '../../src/platform/runtime-performance.js';
  import {downloadBytes} from '../library.js';
  import {RUNTIME_BUILD_ID} from '../../src/platform/runtime-build.js';
  import {loadingIndicatorShown, setLoadingIndicatorShown} from './loading-indicator.js';

  let status = getRuntimePerformanceStatus();
  onMount(() => {
    const unsubscribe = subscribeRuntimePerformance((value) => {
      status = value;
    });
    return () => {
      unsubscribe();
      stopRuntimePerformanceRecording();
    };
  });

  function download(): void {
    const snapshot = getRuntimePerformanceSnapshot();
    downloadBytes(
      'runtime-timings.json',
      new TextEncoder().encode(JSON.stringify(snapshot, null, 2)),
    );
  }
</script>

<details class="performance-diagnostics">
  <summary>Performance diagnostics</summary>
  {#if RUNTIME_BUILD_ID}<p>Build: {RUNTIME_BUILD_ID}</p>{/if}
  <p>Start recording, reproduce a stall, then stop and download the timings.</p>
  <div class="file-actions">
    <button type="button" onclick={startRuntimePerformanceRecording} disabled={status.recording}
      >Start recording</button
    >
    <button type="button" onclick={stopRuntimePerformanceRecording} disabled={!status.recording}
      >Stop recording</button
    >
  </div>
  <button class="download" type="button" onclick={download} disabled={!status.hasRecording}
    >Download timings JSON</button
  >
  <p role="status">
    {#if status.hasRecording}
      {status.recording ? 'Recording' : 'Stopped'} · {(status.durationMs / 1000).toFixed(1)}s ·
      {status.eventCount} recent events.
      {#if status.overwrittenEvents}Older events were replaced; totals are retained.{/if}
    {:else}
      Not recording.
    {/if}
  </p>
  <p>
    Timings measure elapsed time, not CPU usage. Browser details are included; game files, names,
    text and images are excluded. Timings stay in memory until downloaded. Starting again replaces
    the previous recording.
  </p>
  <label for="loading-indicator">Loading indicator</label>
  <select
    id="loading-indicator"
    value={$loadingIndicatorShown ? 'shown' : 'hidden'}
    onchange={(event) => setLoadingIndicatorShown(event.currentTarget.value === 'shown')}
  >
    <option value="hidden">Hidden</option><option value="shown">Shown</option>
  </select>
</details>

<style>
  .performance-diagnostics {
    margin-top: 16px;
  }
  summary {
    cursor: pointer;
  }
  p {
    font-size: 12px;
    line-height: 1.5;
  }
  .download,
  select {
    width: 100%;
    margin-top: 8px;
  }
  label {
    display: block;
    margin-top: 12px;
    color: #a9b0bb;
  }
</style>

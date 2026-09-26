<script lang="ts">
  import {audioControls, refreshAudioControls} from './browser-audio-controls.js';
</script>

<details hidden={!$audioControls.available}>
  <summary>Audio diagnostics</summary>
  <p>{$audioControls.status}</p>
  <button type="button" onclick={refreshAudioControls}>Refresh audio status</button>
</details>

<script lang="ts">
  // Mark this shared markup component as TypeScript for the UI checker.
</script>

<section id="installation-files">
  <h2>Game files</h2>
  <button id="choose" type="button">Choose game folder</button>
  <input id="files" type="file" webkitdirectory hidden />
  <button id="installation-folder-fallback" type="button" hidden>Use browser folder picker</button>
  <button id="installation-add-files" type="button">Add files</button>
  <button id="installation-add-file" type="button">Add one file</button>
  <input id="installation-files-input" type="file" multiple hidden />
  <input id="installation-file-input" type="file" hidden />
  <details id="installation-selection" hidden>
    <summary id="installation-selection-summary"></summary>
    <p id="installation-selection-names"></p>
  </details>
  <button id="installation-open" type="button">Open saved game files</button>
  <button id="installation-save" type="button">Keep game files in browser</button>
  <button id="installation-remove" type="button">Remove saved game files</button>
  <button id="installation-cancel" type="button" hidden>Cancel copy</button>
  <p>Read from your device. Never uploaded.</p>
  <p>
    Add files individually if your file manager cannot select several. Added files join the current
    selection; choosing a folder replaces it. Safari may copy selections temporarily.
  </p>
  <p>
    Keep game files in browser storage to reopen them later without selecting the folder. This
    optional copy is separate from saves; the website still needs to load.
  </p>
  <p id="installation-status" role="status"></p>
</section>

<script lang="ts">
  import MediaActivation from './player/MediaActivation.svelte';

  export let game: 'noah' | 'aokana';

  $: noah = game === 'noah';
</script>

<svelte:head>
  <title>{noah ? 'NOAH' : 'Aokana'} · Asset laboratory</title>
  <meta
    name="description"
    content="Inspect local visual novel archives and assets in your browser."
  />
</svelte:head>

<MediaActivation />

<header>
  <span class="eyebrow"
    >{noah ? 'CHAOS;HEAD NOAH / WEB ENGINE' : 'AOKANA ULTIMATE EDITION / BURIKO'}</span
  >
  <h1>Asset laboratory</h1>
  <p>
    {noah
      ? 'Explore local archives. Images, characters, audio, movies, and scripts stay on your device.'
      : 'Explore local archives, images, scripts, sound, fonts, and movies.'}
  </p>
</header>
<div class="toolbar">
  <label class="file">
    Choose game folder
    <input id="files" type="file" webkitdirectory />
  </label>
  {#if noah}
    <button id="storage" type="button">User data</button>
    <button id="vm-boot" type="button">Diagnostic player</button>
    <a href="./aokana-assets.html">Aokana explorer</a>
    <a href="./index.html">Game library</a>
  {:else}
    <a href="./assets.html">MAGES explorer</a>
    <a href="./index.html">Game library</a>
  {/if}
  <span id="status" role="status">Choose your game installation folder.</span>
</div>
<main>
  <aside>
    <label>
      {noah ? 'Archive' : 'Archive or file'}
      <select id="archives" aria-label={noah ? 'Archive' : 'Archive or file'}></select>
    </label>
    <label>
      {noah ? 'Filter by ID or name' : 'Filter by index or name'}
      <input id="filter" type="search" placeholder={noah ? 'e.g. 10' : 'Name or entry index'} />
    </label>
    <p id="count"></p>
    {#if !noah}
      <div class="pages">
        <button id="previous" type="button">Previous</button>
        <button id="next" type="button">Next</button>
      </div>
    {/if}
    <div id="entries"></div>
  </aside>
  <section id="viewer" aria-label="Asset preview">
    <div class="empty">
      <span>01 / ASSETS</span>
      <h2>{noah ? 'Start with the source.' : 'Open your installation.'}</h2>
      <p>
        {noah
          ? 'PNG and WebP previews · character composition · HCA audio · USM movie playback · decompressed scripts'
          : 'ARC20 · BSE · DSC · CompressedBG · BF_Movie · Ogg Vorbis · MP4 · fonts · SDC'}
      </p>
      <p>
        Choose files from your device. This explorer does not upload files or execute game scripts.
      </p>
    </div>
  </section>
</main>

<script lang="ts">
  import {onMount} from 'svelte';
  import {browserFullscreenElement} from '../../src/platform/browser-fullscreen.js';
  import type {BrowserMediaActivationRequest} from '../../src/video/browser-media-activation.js';
  export let request: BrowserMediaActivationRequest;
  let card: HTMLElement;
  let button: HTMLButtonElement;

  onMount(() => {
    const document = card.ownerDocument;
    const previousFocus = document.activeElement;
    const mount = () => (browserFullscreenElement(document) ?? document.body).append(card);
    for (const name of ['fullscreenchange', 'webkitfullscreenchange'])
      document.addEventListener(name, mount);
    mount();
    button.focus({preventScroll: true});
    return () => {
      for (const name of ['fullscreenchange', 'webkitfullscreenchange'])
        document.removeEventListener(name, mount);
      if (card.contains(document.activeElement)) {
        const target = request.returnFocus ?? previousFocus;
        if (target?.isConnected && 'focus' in target)
          (target as HTMLElement).focus({preventScroll: true});
      }
      card.remove();
    };
  });
</script>

<!-- Keep the keyed component anchor in place while its prompt follows fullscreen. -->
<div hidden>
  <section bind:this={card} class="media-activation" aria-label="Video playback">
    <p role="status">Your browser paused video playback. Select Play video to continue.</p>
    <button
      bind:this={button}
      type="button"
      disabled={request.pending}
      onclick={() => request.retry()}>Play video</button
    >
  </section>
</div>

<style>
  .media-activation {
    position: fixed;
    z-index: 2147483647;
    bottom: 1rem;
    left: 1rem;
    right: 1rem;
    margin: 0 auto;
    max-width: 32rem;
    padding: 1rem;
    border: 1px solid #7484a5;
    border-radius: 0.5rem;
    background: #10131c;
    color: #fff;
    font:
      1rem system-ui,
      sans-serif;
    text-align: center;
    pointer-events: auto;
  }
  button {
    padding: 0.6rem 1rem;
    font: inherit;
    color: #fff;
    background: #26344e;
    border: 1px solid #7484a5;
    border-radius: 0.35rem;
    cursor: pointer;
  }
</style>

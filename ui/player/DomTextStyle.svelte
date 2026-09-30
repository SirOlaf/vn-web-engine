<script lang="ts">
  import {onMount} from 'svelte';
  import {
    getDomTextStyle,
    hasDomTextFont,
    normalizeDomTextStyle,
    setDomTextFont,
    setDomTextStyle,
    type DomTextStyle,
  } from '../../src/text/dom-text-style.js';
  import {IndexedDbStore} from '../../src/platform/store.js';

  const storageKey = 'vn-web-engine.dom-text-style';
  const fontNamespace = ['vn-web-engine', 'dom-text-font'];
  let style: DomTextStyle = getDomTextStyle();
  let fontName = '';
  let fontMessage = '';

  function update(change: Partial<DomTextStyle>): void {
    setDomTextStyle(change);
    style = getDomTextStyle();
    try {
      localStorage.setItem(storageKey, JSON.stringify(style));
    } catch {
      /* Keep the live style even when it cannot be remembered. */
    }
  }

  /** Replaces the remembered reader font; null forgets it. */
  async function storeFont(name: string | null, bytes: Uint8Array | null): Promise<void> {
    const store = await IndexedDbStore.open(fontNamespace);
    try {
      await store.update((records) => {
        records.clear();
        if (name !== null && bytes !== null) records.set(name, bytes);
      });
    } finally {
      store.close();
    }
  }

  onMount(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved !== null) {
        setDomTextStyle(normalizeDomTextStyle(JSON.parse(saved)));
        style = getDomTextStyle();
      }
    } catch {
      /* Native styling applies when browser storage is unavailable or invalid. */
    }
    void (async () => {
      try {
        const store = await IndexedDbStore.open(fontNamespace);
        let records;
        try {
          records = await store.snapshot();
        } finally {
          store.close();
        }
        const [name, bytes] = [...records][0] ?? [];
        if (name === undefined || bytes === undefined || hasDomTextFont()) return;
        await setDomTextFont(bytes);
        fontName = name;
      } catch {
        fontMessage = 'The saved font could not be loaded.';
      }
    })();
  });

  async function chooseFont(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement,
      file = input.files?.[0];
    input.value = '';
    if (!file) return;
    fontMessage = '';
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await setDomTextFont(bytes);
      fontName = file.name;
      try {
        await storeFont(file.name, bytes);
      } catch {
        fontMessage = 'The font is active but will not be remembered.';
      }
    } catch {
      fontMessage = `${file.name} is not a font this browser can load.`;
    }
  }

  async function removeFont(): Promise<void> {
    await setDomTextFont(null);
    fontName = '';
    fontMessage = '';
    try {
      await storeFont(null, null);
    } catch {
      /* The font is already inactive for this page. */
    }
  }

  const cssPlaceholder = `.game-text { letter-spacing: 0.05em; }
.game-text-marker { visibility: hidden; }
[data-font-size="18"] { font-size: 20px; }`;
  // Mirrors domTextClasses plus the engine classes documented in docs/dom-text.md.
  const cssClasses = [
    ['game-text', 'all text'],
    ['game-text-horizontal / -vertical', 'writing direction'],
    ['game-text-multiline', 'more than one native row'],
    ['game-text-inert', 'text that does not accept selection'],
    ['game-text-overlay', 'BGI: text drawn in a window layer'],
    ['game-text-marker', 'BGI: control at the end of dialogue (wait marker)'],
    ['game-text-body / -name / -ruby', 'NOAH: dialogue role'],
    ['game-text-source-scene / -backlog / …', 'NOAH: drawing source'],
    ['[data-font-size="N"]', 'native font size in px'],
  ] as const;
</script>

<details id="dom-text-style-options">
  <summary>Custom text style</summary>
  <label class="dom-style-toggle">
    <input
      type="checkbox"
      checked={style.enabled}
      onchange={(e) => update({enabled: e.currentTarget.checked})}
      aria-describedby="dom-text-style-help"
    />
    Use custom style for DOM text
  </label>
  <p id="dom-text-style-help">
    Replaces the game’s font choices in DOM text mode. Text no longer lines up exactly with the
    game’s layout.
  </p>
  <fieldset disabled={!style.enabled}>
    <label for="dom-text-family">Font families</label>
    <input
      id="dom-text-family"
      type="text"
      placeholder="Game font"
      spellcheck="false"
      value={style.family}
      onchange={(e) => update({family: e.currentTarget.value})}
      aria-describedby="dom-text-family-help"
    />
    <p id="dom-text-family-help">
      Installed fonts as a CSS list, for example <code>"Noto Sans JP", sans-serif</code>.
    </p>
    <label for="dom-text-font-file">Font file</label>
    <div class="file-actions">
      <input
        id="dom-text-font-file"
        type="file"
        accept=".ttf,.otf,.ttc,.woff,.woff2"
        onchange={chooseFont}
      />
      {#if fontName}
        <button type="button" onclick={removeFont}>Remove</button>
      {/if}
    </div>
    {#if fontName}<p>Using {fontName} before the font families above.</p>{/if}
    {#if fontMessage}<p role="status">{fontMessage}</p>{/if}
    <label for="dom-text-scale">Size: {Math.round(style.scale * 100)}%</label>
    <input
      id="dom-text-scale"
      type="range"
      min="50"
      max="200"
      step="5"
      value={Math.round(style.scale * 100)}
      oninput={(e) => update({scale: Number(e.currentTarget.value) / 100})}
    />
    <label for="dom-text-weight">Weight</label>
    <select
      id="dom-text-weight"
      value={style.weight === null ? '' : String(style.weight)}
      onchange={(e) =>
        update({weight: e.currentTarget.value === '' ? null : Number(e.currentTarget.value)})}
    >
      <option value="">Game weight</option>
      <option value="300">Light</option>
      <option value="400">Regular</option>
      <option value="500">Medium</option>
      <option value="700">Bold</option>
    </select>
    <label class="dom-style-toggle">
      <input
        type="checkbox"
        checked={style.effects}
        onchange={(e) => update({effects: e.currentTarget.checked})}
      />
      Game shadows and outlines
    </label>
    <label for="dom-text-layout">Layout</label>
    <select
      id="dom-text-layout"
      value={style.layout}
      onchange={(e) => update({layout: e.currentTarget.value === 'natural' ? 'natural' : 'fit'})}
      aria-describedby="dom-text-layout-help"
    >
      <option value="fit">Fit to game text area</option>
      <option value="natural">Natural font spacing</option>
    </select>
    <p id="dom-text-layout-help">
      Natural spacing keeps the font’s own widths and line height, so text can extend past the
      game’s text window.
    </p>
    <label for="dom-text-css">Additional CSS</label>
    <textarea
      id="dom-text-css"
      rows="6"
      spellcheck="false"
      placeholder={cssPlaceholder}
      value={style.css}
      onchange={(e) => update({css: e.currentTarget.value})}
      aria-describedby="dom-text-css-help"></textarea>
    <p id="dom-text-css-help">
      Rules apply to DOM text only and override the game’s layout; declarations without a selector
      apply to all text. Select text by class:
    </p>
    <dl class="dom-css-classes">
      {#each cssClasses as [name, meaning] (name)}
        <dt><code>{name}</code></dt>
        <dd>{meaning}</dd>
      {/each}
    </dl>
  </fieldset>
</details>

<style>
  details {
    margin-top: 12px;
  }
  summary {
    cursor: pointer;
    color: #a9b0bb;
  }
  fieldset {
    border: 0;
    margin: 0;
    padding: 0;
    min-width: 0;
  }
  fieldset[disabled] {
    opacity: 0.55;
  }
  label {
    display: block;
    margin-top: 10px;
    color: #a9b0bb;
  }
  .dom-style-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  input[type='text'],
  input[type='range'],
  select,
  textarea {
    display: block;
    box-sizing: border-box;
    width: 100%;
    margin-top: 6px;
  }
  input[type='file'] {
    min-width: 0;
    flex: 1;
  }
  .dom-css-classes {
    margin: 6px 0 0;
    font-size: 12px;
  }
  .dom-css-classes dt {
    margin-top: 4px;
    overflow-wrap: anywhere;
  }
  .dom-css-classes dd {
    margin: 0 0 0 12px;
    color: #a9b0bb;
  }
  textarea {
    font-family: ui-monospace, monospace;
    resize: vertical;
  }
  p {
    font-size: 13px;
  }
</style>

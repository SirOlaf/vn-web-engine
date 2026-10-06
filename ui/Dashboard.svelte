<script lang="ts">
  import {onMount, tick} from 'svelte';
  import {installationStatus, type InstallationStatus} from './library.js';
  import {lastPlayed} from './player/last-played.js';
  import {knownGames, type KnownGame} from './game-data.js';
  import GameDataTree from './GameDataTree.svelte';
  import {PLAYERS, playerEntry, type PlayerEntry, type PlayerId} from './players/registry.js';
  import {detectionMessage, detectPlayers, openInPlayer} from './players/detect.js';
  import {
    hasInstallationDirectoryPicker,
    pickInstallationDirectory,
    selectedInstallationFiles,
    type InstallationSelection,
  } from '../src/platform/installation-picker.js';

  type TileId = PlayerId | 'folder';

  interface MenuOption {
    readonly label: string;
    readonly href?: string;
    readonly run?: () => void;
    readonly disabled?: boolean;
  }

  const TILES: readonly TileId[] = [...PLAYERS.map((entry) => entry.id), 'folder'];
  /** The carousel repeats the tiles so the row loops; the cursor rests in the middle copy. */
  const COPIES = 5;
  const MIDDLE = Math.floor(COPIES / 2) * TILES.length;
  const RING = Array.from({length: COPIES * TILES.length}, (_, i) => i);
  const tileAt = (index: number): TileId =>
    TILES[((index % TILES.length) + TILES.length) % TILES.length]!;

  let cursor = MIDDLE;
  let view: 'options' | 'games' = 'options';
  let option = 0;
  let installations: Partial<Record<PlayerId, InstallationStatus>> = {};
  let slots: HTMLButtonElement[] = [];
  let optionElements: HTMLElement[] = [];
  let gameElements: HTMLElement[] = [];
  let track: HTMLElement;
  let trackOffset = 0;
  /** Set once the first layout is placed, so nothing animates into its initial position. */
  let settled = false;
  /** Set while the track jumps between identical copies, which must not animate. */
  let snapping = false;

  let games: readonly KnownGame[] | null = null;
  /** Index into the games view: 0 is the back row, games follow. */
  let gameIndex = 0;
  let game: KnownGame | null = null;
  let tree: GameDataTree | undefined;
  /** Whether focus is in the games list; its highlight shows only then. */
  let listFocused = false;

  $: selected = tileAt(cursor);
  $: player = selected === 'folder' ? null : playerEntry(selected);
  $: options = optionsFor(selected, matches, detecting, installations);

  function optionsFor(
    id: TileId,
    found: readonly PlayerEntry[],
    busy: boolean,
    statuses: typeof installations,
  ): readonly MenuOption[] {
    if (id === 'folder')
      return [
        {label: busy ? 'Reading folder…' : 'Select folder', run: chooseFolder, disabled: busy},
        ...(found.length > 1
          ? found.map((entry) => ({label: `Open in ${entry.title}`, href: entry.route}))
          : []),
      ];
    const entry = playerEntry(id);
    // A remembered folder or browser copy reopens in the player, so it can be played directly.
    const reopens = statuses[id]?.reopens ?? false;
    const last = reopens ? lastPlayed(id) : null;
    return [
      {
        label: reopens ? (last ? `Play ${last}` : 'Play last') : 'Play',
        href: entry.route,
      },
      {label: 'Game data', run: openGames},
      ...(entry.explorerRoute ? [{label: 'Asset lab', href: entry.explorerRoute}] : []),
    ];
  }

  async function refreshInstallations(): Promise<void> {
    const statuses = await Promise.all(PLAYERS.map((entry) => installationStatus(entry)));
    installations = Object.fromEntries(PLAYERS.map((entry, i) => [entry.id, statuses[i]]));
  }

  let detecting = false;
  let detection = '';
  let matches: readonly PlayerEntry[] = [];
  let folderInput: HTMLInputElement;

  /** Picks a game folder and opens it in the player whose engine markers it carries. */
  function chooseFolder(): void {
    if (detecting) return;
    // The picker call itself happens synchronously in this gesture.
    if (hasInstallationDirectoryPicker(window)) void detect(pickInstallationDirectory(window));
    else folderInput.click();
  }
  function folderChosen(): void {
    const files = Array.from(folderInput.files ?? []);
    folderInput.value = '';
    if (files.length)
      void detect(Promise.resolve().then(() => selectedInstallationFiles(files, true)));
  }
  async function detect(picked: Promise<InstallationSelection>): Promise<void> {
    detecting = true;
    detection = 'Reading the folder…';
    matches = [];
    try {
      const selection = await picked;
      detection = 'Looking for engine markers…';
      const found = await detectPlayers(selection);
      matches = found;
      const handedOff = found.length === 1 && (await openInPlayer(found[0]!, selection));
      detection = detectionMessage(found, handedOff);
    } catch (error) {
      detection =
        error instanceof Error && error.name === 'AbortError'
          ? ''
          : error instanceof Error
            ? error.message
            : String(error);
    } finally {
      detecting = false;
    }
  }

  /** Centres the slot under the cursor. */
  function placeTrack(): void {
    const slot = slots[cursor];
    if (track && slot)
      trackOffset = track.clientWidth / 2 - (slot.offsetLeft + slot.offsetWidth / 2);
  }

  /** Moves the cursor to the middle copy of its tile without animating; the view is unchanged. */
  async function recentre(): Promise<void> {
    const middle = MIDDLE + TILES.indexOf(selected);
    if (cursor === middle) return;
    snapping = true;
    cursor = middle;
    await tick();
    placeTrack();
    await tick();
    void track.offsetWidth; // Commit the jump before transitions return.
    snapping = false;
  }

  async function moveTo(index: number, focusOption: boolean): Promise<void> {
    cursor = index;
    view = 'options';
    option = 0;
    await tick();
    placeTrack();
    if (focusOption) optionElements[0]?.focus();
  }

  async function step(offset: number): Promise<void> {
    await recentre();
    await moveTo(cursor + offset, true);
  }

  async function moveOption(offset: number): Promise<void> {
    option = Math.min(options.length - 1, Math.max(0, option + offset));
    await tick();
    optionElements[option]?.focus();
  }

  async function openGames(): Promise<void> {
    if (!player) return;
    const id = player.id;
    view = 'games';
    games = null;
    game = null;
    gameIndex = 0;
    await tick();
    gameElements[0]?.focus();
    const found = await knownGames(id).catch(() => []);
    if (selected !== id || view !== 'games') return;
    games = found;
    gameIndex = found.length ? 1 : 0;
    game = found[0] ?? null;
    await tick();
    gameElements[gameIndex]?.focus();
  }
  async function moveGame(offset: number): Promise<void> {
    gameIndex = Math.min(games?.length ?? 0, Math.max(0, gameIndex + offset));
    if (gameIndex > 0) game = games![gameIndex - 1]!;
    await tick();
    gameElements[gameIndex]?.focus();
  }
  async function back(): Promise<void> {
    view = 'options';
    await tick();
    optionElements[option]?.focus();
  }

  /** Home-screen controls: left/right choose a tile, up/down choose an option, Escape goes back. */
  function homeKey(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, select, textarea')) return;
    if (event.key === 'Escape' && view !== 'options') void back();
    else if (view === 'games') {
      // The tree and its actions handle their own keys.
      if (target.closest('.data-files')) return;
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown')
        void moveGame(event.key === 'ArrowUp' ? -1 : 1);
      else if (event.key === 'ArrowRight' && gameIndex > 0) void tree?.focus();
      else if (event.key === 'ArrowLeft') void back();
      else return;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
      void step(event.key === 'ArrowLeft' ? -1 : 1);
    else if (event.key === 'ArrowUp' || event.key === 'ArrowDown')
      void moveOption(event.key === 'ArrowUp' ? -1 : 1);
    else return;
    event.preventDefault();
  }

  onMount(() => {
    void refreshInstallations();
    void moveTo(cursor, true).then(() =>
      requestAnimationFrame(() => requestAnimationFrame(() => (settled = true))),
    );
  });
</script>

<svelte:window onkeydown={homeKey} onresize={placeTrack} />
<!-- Statuses are reread whenever the page returns to view, e.g. back from a player. -->
<svelte:document
  onvisibilitychange={() => document.visibilityState === 'visible' && refreshInstallations()}
/>

<input bind:this={folderInput} type="file" webkitdirectory hidden onchange={folderChosen} />

{#snippet tile(index: number)}
  {@const id = tileAt(index)}
  {@const entry = id === 'folder' ? null : playerEntry(id)}
  {@const copy = Math.floor(index / TILES.length) * TILES.length !== MIDDLE}
  {@const distance = Math.abs(index - cursor)}
  <button
    bind:this={slots[index]}
    type="button"
    class="tile"
    class:folder-tile={!entry}
    class:selected={cursor === index}
    class:near={distance === 1}
    class:edge={distance === 2}
    class:far={distance > 2}
    class:before={index < cursor}
    data-accent={id}
    aria-pressed={cursor === index}
    aria-label={entry?.engineName ?? 'Auto-detect'}
    aria-hidden={distance > 1 || (copy && distance !== 0)}
    tabindex={cursor === index ? 0 : -1}
    onclick={() =>
      cursor === index && view === 'options' ? optionElements[0]?.focus() : moveTo(index, true)}
  >
    {#if entry}
      <span class="card-art" aria-hidden="true">
        <span class="card-initials">{entry.initials}</span>
      </span>
    {:else}
      <span class="slot" aria-hidden="true"><span class="disc"></span></span>
    {/if}
    <span class="tile-name" aria-hidden="true">{entry?.engineName ?? 'Auto-detect'}</span>
  </button>
{/snippet}

{#snippet gameList()}
  <button
    bind:this={gameElements[0]}
    class="option back"
    class:current={listFocused && gameIndex === 0}
    type="button"
    onfocus={() => (gameIndex = 0)}
    onclick={back}><span aria-hidden="true">‹</span> Game data</button
  >
  {#if games === null}
    <p class="tree-note">Looking for games…</p>
  {:else if games.length === 0}
    <p class="tree-note">No games loaded yet. Games appear here once they have been played.</p>
  {:else}
    <div class="options">
      {#each games as entry, i (entry.id)}
        <button
          bind:this={gameElements[i + 1]}
          class="option"
          class:current={listFocused && gameIndex === i + 1}
          class:chosen={game === entry}
          type="button"
          onfocus={() => {
            gameIndex = i + 1;
            game = entry;
          }}
          onclick={() => tree?.focus()}>{entry.title}</button
        >
      {/each}
    </div>
  {/if}
{/snippet}

{#snippet optionList()}
  <div class="options">
    {#each options as entry, i (entry.label)}
      {#if entry.href}
        <a
          bind:this={optionElements[i]}
          class="option"
          class:current={option === i}
          href={entry.href}
          onfocus={() => (option = i)}>{entry.label}</a
        >
      {:else}
        <button
          bind:this={optionElements[i]}
          class="option"
          class:current={option === i}
          type="button"
          disabled={entry.disabled}
          onfocus={() => (option = i)}
          onclick={entry.run}>{entry.label}</button
        >
      {/if}
    {/each}
  </div>
  {#if !player && detection}<p class="tree-note" role="status">{detection}</p>{/if}
{/snippet}

<div class="app-shell" class:settled data-accent={selected}>
  <header class="systembar">
    <a class="brand" href="./index.html" aria-label="VN Web Engine library">
      <span class="brand-mark" aria-hidden="true">VN</span>
      <span class="brand-name">Library</span>
    </a>
    <p class="bar-summary">
      {player?.summary ?? 'Opens a game folder in the player of its engine.'}
    </p>
    <a class="bar-link" href="https://github.com/SirOlaf/vn-web-engine" title="Source code"
      >GitHub</a
    >
  </header>

  <main class="home">
    <div class="tile-row carousel" role="group" aria-label="Library">
      <div
        class="track"
        class:snapping
        bind:this={track}
        style:transform="translateX({trackOffset}px)"
        ontransitionend={(event) => {
          if (event.target === track && event.propertyName === 'transform') void recentre();
        }}
      >
        {#each RING as index (index)}{@render tile(index)}{/each}
      </div>
    </div>
    <section
      class="menu menu-column"
      class:data={view === 'games'}
      aria-label="{player?.engineName ?? 'Auto-detect'} options"
    >
      {#if view === 'options'}
        <div class="menu-col options-col">{@render optionList()}</div>
      {/if}
      {#if view === 'games'}
        <div
          class="menu-col data-games"
          onfocusin={() => (listFocused = true)}
          onfocusout={() => (listFocused = false)}
        >
          {@render gameList()}
        </div>
        <div class="menu-col data-files">
          {#if game}
            {#key game}
              <GameDataTree
                bind:this={tree}
                {game}
                onexitleft={() => gameElements[gameIndex]?.focus()}
              />
            {/key}
          {/if}
        </div>
      {/if}
    </section>
  </main>

  <footer class="hintbar" aria-label="Controls">
    <span><kbd>←</kbd><kbd>→</kbd> Choose</span>
    <span><kbd>↑</kbd><kbd>↓</kbd> Option</span>
    <span><kbd>Enter</kbd> Select</span>
    <span><kbd>Esc</kbd> Back</span>
  </footer>
</div>

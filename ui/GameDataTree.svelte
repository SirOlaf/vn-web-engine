<script lang="ts">
  import {onMount, tick} from 'svelte';
  import {downloadBytes} from './library.js';
  import type {GameDataFile, KnownGame} from './game-data.js';

  interface TreeNode {
    readonly name: string;
    readonly path: string;
    readonly kind: 'directory' | 'file';
    readonly size: number;
    readonly children: TreeNode[];
  }
  interface Row {
    readonly node: TreeNode;
    readonly depth: number;
    readonly parent: TreeNode | null;
  }

  let {
    game,
    autofocus = false,
    onexitleft,
  }: {
    game: KnownGame;
    autofocus?: boolean;
    /** Left on a top-level row leaves the tree. */
    onexitleft?: () => void;
  } = $props();

  let roots: TreeNode[] = $state([]);
  let loading = $state(true);
  /** Focus asked for while loading, given once the rows exist. */
  let focusPending = false;
  let collapsed = $state(new Set<string>());
  let current = $state('');
  let message = $state('');
  let busy = $state(false);
  let rowElements: HTMLElement[] = $state([]);
  let actionsElement: HTMLElement | undefined = $state();
  let cancelButton: HTMLButtonElement | undefined = $state();
  let replaceInput: HTMLInputElement;
  let addInput: HTMLInputElement;
  /** A destructive change awaiting confirmation. */
  let confirming: {question: string; label: string; run: () => Promise<string>} | null =
    $state(null);

  /** Builds the directory tree, merging chains of single directories into one row. */
  function build(files: readonly GameDataFile[], directories: readonly string[]): TreeNode[] {
    const top: TreeNode[] = [];
    const entries = [
      ...directories.map((path) => ({path, size: 0, directory: true})),
      ...files.map((file) => ({...file, directory: false})),
    ];
    for (const file of entries) {
      const parts = file.path.split('\\');
      let level = top;
      parts.forEach((name, i) => {
        const path = parts.slice(0, i + 1).join('\\');
        const kind = i === parts.length - 1 && !file.directory ? 'file' : 'directory';
        let node = level.find((entry) => entry.name === name && entry.kind === kind);
        if (!node) level.push((node = {name, path, kind, size: file.size, children: []}));
        level = node.children;
      });
    }
    const compact = (node: TreeNode): TreeNode => {
      let merged = node;
      while (
        merged.kind === 'directory' &&
        merged.children.length === 1 &&
        merged.children[0]!.kind === 'directory'
      ) {
        const child = merged.children[0]!;
        merged = {...child, name: `${merged.name}\\${child.name}`};
      }
      return {...merged, children: sort(merged.children.map(compact))};
    };
    const sort = (nodes: TreeNode[]): TreeNode[] =>
      nodes.sort(
        (left, right) =>
          Number(left.kind === 'file') - Number(right.kind === 'file') ||
          left.name.localeCompare(right.name),
      );
    return sort(top.map(compact));
  }

  const rows = $derived.by(() => {
    const visible: Row[] = [];
    const visit = (nodes: readonly TreeNode[], depth: number, parent: TreeNode | null): void => {
      for (const node of nodes) {
        visible.push({node, depth, parent});
        if (node.kind === 'directory' && !collapsed.has(node.path))
          visit(node.children, depth + 1, node);
      }
    };
    visit(roots, 0, null);
    return visible;
  });
  const selected = $derived(rows.find((row) => row.node.path === current)?.node ?? null);
  const filesUnder = (node: TreeNode): string[] =>
    node.kind === 'file' ? [node.path] : node.children.flatMap(filesUnder);
  const selectedFiles = $derived(selected ? filesUnder(selected) : []);
  /** Files can be added inside the game's own directories only. */
  const writable = $derived(
    selected?.kind === 'directory' &&
      game.directories.some(
        (root) =>
          selected.path.toUpperCase() === root.toUpperCase() ||
          selected.path.toUpperCase().startsWith(root.toUpperCase() + '\\'),
      ),
  );

  async function load(): Promise<void> {
    loading = true;
    try {
      roots = build(await game.list(), game.directories);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
      roots = [];
    } finally {
      loading = false;
    }
    if (!rows.some((row) => row.node.path === current)) current = rows[0]?.node.path ?? '';
  }

  export async function focus(): Promise<void> {
    if (loading) {
      focusPending = true;
      return;
    }
    await tick();
    const row =
      rowElements[
        Math.max(
          0,
          rows.findIndex((entry) => entry.node.path === current),
        )
      ];
    row?.focus();
    row?.scrollIntoView({block: 'nearest'});
  }

  async function moveTo(index: number): Promise<void> {
    const row = rows[Math.min(rows.length - 1, Math.max(0, index))];
    if (!row) return;
    current = row.node.path;
    await focus();
  }

  function toggle(node: TreeNode, open = collapsed.has(node.path)): void {
    const next = new Set(collapsed);
    if (open) next.delete(node.path);
    else next.add(node.path);
    collapsed = next;
  }

  function keydown(event: KeyboardEvent): void {
    const index = rows.findIndex((row) => row.node.path === current);
    const row = rows[index];
    if (!row) return;
    const open = row.node.kind === 'directory' && !collapsed.has(row.node.path);
    switch (event.key) {
      case 'ArrowDown':
        void moveTo(index + 1);
        break;
      case 'ArrowUp':
        void moveTo(index - 1);
        break;
      case 'Home':
        void moveTo(0);
        break;
      case 'End':
        void moveTo(rows.length - 1);
        break;
      case 'ArrowRight':
        if (row.node.kind === 'directory' && !open) toggle(row.node, true);
        else if (open) void moveTo(index + 1);
        break;
      case 'ArrowLeft':
        if (open) toggle(row.node, false);
        else if (row.parent) void moveTo(rows.findIndex((entry) => entry.node === row.parent));
        else if (onexitleft) onexitleft();
        break;
      case 'Enter':
        if (row.node.kind === 'directory') toggle(row.node);
        else actionsElement?.querySelector('button')?.focus();
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  async function action(work: () => Promise<string>): Promise<void> {
    if (busy) return;
    busy = true;
    message = '';
    try {
      message = await work();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }

  function exportFile(node: TreeNode): void {
    void action(async () => {
      downloadBytes(node.name, await game.read(node.path));
      return `${node.name} exported.`;
    });
  }

  async function confirm(question: string, label: string, run: () => Promise<string>) {
    confirming = {question, label, run};
    await tick();
    cancelButton?.focus();
  }
  async function settle(accepted: boolean): Promise<void> {
    const pending = confirming;
    confirming = null;
    if (accepted && pending) await action(pending.run);
    await focus();
  }

  function replaceFile(): void {
    const file = replaceInput.files?.[0];
    replaceInput.value = '';
    const node = selected;
    if (!file || !node || node.kind !== 'file') return;
    void confirm(`Replace ${node.name} with ${file.name}?`, 'Replace', async () => {
      await game.write(node.path, new Uint8Array(await file.arrayBuffer()));
      await load();
      return `${node.name} replaced with ${file.name}.`;
    });
  }

  function addFiles(): void {
    const files = Array.from(addInput.files ?? []);
    addInput.value = '';
    const node = selected;
    if (!files.length || !node || node.kind !== 'directory') return;
    const target = (file: File): string => `${node.path}\\${file.name}`;
    const existing = new Set(filesUnder(node).map((path) => path.toUpperCase()));
    const replaced = files.filter((file) => existing.has(target(file).toUpperCase()));
    const run = async (): Promise<string> => {
      for (const file of files)
        await game.write(target(file), new Uint8Array(await file.arrayBuffer()));
      toggle(node, true);
      await load();
      return files.length === 1 ? `${files[0]!.name} added.` : `${files.length} files added.`;
    };
    if (replaced.length)
      void confirm(
        replaced.length === 1
          ? `${replaced[0]!.name} already exists. Replace it?`
          : `${replaced.length} of these files already exist. Replace them?`,
        'Replace',
        run,
      );
    else void action(run);
  }

  function deleteSelected(): void {
    const node = selected;
    if (!node) return;
    const paths = filesUnder(node);
    if (!paths.length) return;
    void confirm(
      node.kind === 'file'
        ? `Delete ${node.name}? This cannot be undone.`
        : `Delete the ${paths.length} ${paths.length === 1 ? 'file' : 'files'} in ${node.name}? This cannot be undone.`,
      'Delete',
      async () => {
        await game.remove(paths);
        await load();
        return node.kind === 'file' ? `${node.name} deleted.` : `${paths.length} files deleted.`;
      },
    );
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  }

  onMount(() => {
    void load().then(() => (autofocus || focusPending ? focus() : undefined));
  });
</script>

<div class="data-tree">
  {#if loading}
    <p class="tree-note">Reading stored files…</p>
  {:else}
    <!-- svelte-ignore a11y_interactive_supports_focus -->
    <div class="tree" role="tree" aria-label="{game.title} files" onkeydown={keydown}>
      {#each rows as row, i (row.node.path)}
        <div
          bind:this={rowElements[i]}
          class="tree-row"
          class:current={row.node.path === current}
          role="treeitem"
          aria-level={row.depth + 1}
          aria-selected={row.node.path === current}
          aria-expanded={row.node.kind === 'directory' ? !collapsed.has(row.node.path) : undefined}
          tabindex={row.node.path === current ? 0 : -1}
          style:--depth={row.depth}
          onclick={() => {
            current = row.node.path;
            if (row.node.kind === 'directory') toggle(row.node);
          }}
          onkeydown={() => undefined}
        >
          <span class="tree-icon" aria-hidden="true"
            >{row.node.kind === 'file' ? '·' : collapsed.has(row.node.path) ? '▸' : '▾'}</span
          >
          <span class="tree-name">{row.node.name}</span>
          {#if row.node.kind === 'file'}<span class="tree-size">{formatSize(row.node.size)}</span
            >{/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if confirming}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="tree-detail tree-confirm"
      role="group"
      aria-label="Confirm"
      onkeydown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        void settle(false);
      }}
    >
      <p>{confirming.question}</p>
      <div class="tree-actions">
        <button type="button" class="danger" disabled={busy} onclick={() => settle(true)}
          >{confirming.label}</button
        >
        <button bind:this={cancelButton} type="button" onclick={() => settle(false)}>Cancel</button>
      </div>
    </div>
  {:else if selected}
    <div class="tree-detail">
      <div class="tree-actions" bind:this={actionsElement}>
        {#if selected.kind === 'file'}
          <button type="button" disabled={busy} onclick={() => exportFile(selected)}>Export</button>
          <button type="button" disabled={busy} onclick={() => replaceInput.click()}
            >Replace…</button
          >
        {:else if writable}
          <button type="button" disabled={busy} onclick={() => addInput.click()}>Add files…</button>
        {/if}
        {#if selectedFiles.length}
          <button type="button" class="danger" disabled={busy} onclick={deleteSelected}
            >Delete</button
          >
        {/if}
      </div>
      {#if selected.kind === 'directory'}
        <p class="tree-note">
          {selectedFiles.length}
          {selectedFiles.length === 1 ? 'file' : 'files'}
        </p>
      {/if}
    </div>
  {/if}
  <input bind:this={replaceInput} type="file" hidden onchange={replaceFile} />
  <input bind:this={addInput} type="file" multiple hidden onchange={addFiles} />
  <p class="tree-message" role="status">{message}</p>
</div>

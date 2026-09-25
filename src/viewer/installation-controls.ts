import {BrowserInstallationCache, type CachedInstallation} from '../platform/installation-cache.js';
import {
  hasInstallationDirectoryPicker,
  hasInstallationFilePicker,
  pickInstallationDirectory,
  pickInstallationFiles,
  InstallationSelectionFiles,
  selectedInstallationFiles,
  type InstallationSelection,
} from '../platform/installation-picker.js';

/** Shared installation UI; engines only interpret the selected tree and its game metadata. */
export function mountInstallationControls(options: {
  key: string;
  choose: HTMLButtonElement;
  input: HTMLInputElement;
  current(): CachedInstallation | null;
  select(selection: InstallationSelection): Promise<void>;
  load(installation: CachedInstallation): Promise<void>;
  clear(): void;
  busy(): boolean;
  setBusy(busy: boolean): void;
  report(message: string): void;
  canonicalPath?(path: string): string;
  selectedPath?(path: string, directory: boolean): string;
}): {refresh(): void; resetSelection(): void} {
  const section = options.choose.parentElement!;
  const cache = new BrowserInstallationCache();
  const controls: HTMLButtonElement[] = [];
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.style.overflowWrap = 'anywhere';
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.hidden = true;
  const single = document.createElement('input');
  single.type = 'file';
  single.hidden = true;
  const selectionFiles = new InstallationSelectionFiles(
    options.canonicalPath,
    options.selectedPath,
  );
  const selectedDetails = document.createElement('details');
  selectedDetails.hidden = true;
  const selectedSummary = document.createElement('summary');
  const selectedNames = document.createElement('p');
  selectedNames.style.whiteSpace = 'pre-wrap';
  selectedNames.style.overflowWrap = 'anywhere';
  selectedNames.style.maxHeight = '14em';
  selectedNames.style.overflowY = 'auto';
  selectedDetails.append(selectedSummary, selectedNames);
  let working = false;
  let cachedInstallation: CachedInstallation | null = null;
  let abort: AbortController | null = null;
  function message(text: string): void {
    status.textContent = text;
    options.report(text);
  }
  function button(label: string, action: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.onclick = action;
    section.append(button);
    controls.push(button);
    return button;
  }
  async function run(work: () => Promise<void>): Promise<void> {
    if (working || options.busy()) return;
    working = true;
    options.setBusy(true);
    refresh();
    try {
      await work();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError')
        message('Selection or copy cancelled.');
      else message(error instanceof Error ? error.message : String(error));
    } finally {
      abort = null;
      cancel.hidden = true;
      working = false;
      options.setBusy(false);
      refresh();
    }
  }
  function resetSelection(): void {
    selectionFiles.clear();
    selectedDetails.hidden = true;
    selectedNames.textContent = '';
  }
  async function select(selection: InstallationSelection): Promise<void> {
    const combined = selectionFiles.add(selection);
    selectedDetails.hidden = false;
    selectedSummary.textContent = `${combined.files.length} selected files`;
    selectedNames.textContent = combined.files.map(({path}) => path).join('\n');
    await options.select(combined);
    message('Device files ready. Press Play.');
  }
  options.choose.onclick = () => {
    if (working || options.busy()) return;
    if (hasInstallationDirectoryPicker(window)) {
      // The picker call itself happens synchronously in this gesture.
      const picked = pickInstallationDirectory(window);
      void run(async () => {
        message('Reading folder entries…');
        await select(await picked);
      });
    } else options.input.click();
  };
  if (hasInstallationDirectoryPicker(window))
    button('Use browser folder picker', () => options.input.click());
  options.input.onchange = () => {
    const files = Array.from(options.input.files ?? []);
    options.input.value = '';
    if (!files.length) return;
    void run(async () => {
      await select(selectedInstallationFiles(files, true));
    });
  };
  button('Add files', () => {
    if (hasInstallationFilePicker(window)) {
      const picked = pickInstallationFiles(window);
      void run(async () => {
        await select(await picked);
      });
    } else input.click();
  });
  button('Add one file', () => single.click());
  single.onchange = () => {
    const files = Array.from(single.files ?? []);
    single.value = '';
    if (files.length)
      void run(async () => {
        await select(selectedInstallationFiles(files, false));
      });
  };
  input.onchange = () => {
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (!files.length) return;
    void run(async () => {
      await select(selectedInstallationFiles(files, false));
    });
  };
  const open = button(
    'Open saved game files',
    () =>
      void run(async () => {
        message('Opening browser game files…');
        const installation = await cache.open(options.key);
        if (!installation)
          throw new Error(
            'No game files saved here yet. Open a server installation or choose device files first.',
          );
        await options.load(installation);
        resetSelection();
        cachedInstallation = installation;
        message('Browser game files ready. Game assets will load from this device.');
      }),
  );
  const save = button(
    'Keep game files in browser',
    () =>
      void run(async () => {
        const installation = options.current();
        if (!installation) throw new Error('Open or choose a game first.');
        abort = new AbortController();
        cancel.hidden = false;
        const result = await cache.save(options.key, installation, {
          signal: abort.signal,
          progress: ({path, completedBytes, totalBytes}) => {
            message(
              `Saving ${path}: ${(completedBytes / 1048576).toFixed(1)} / ${(totalBytes / 1048576).toFixed(1)} MiB. Keep this page open.`,
            );
          },
        });
        // Swap the live mount too, so pressing Play no longer streams the server installation.
        const saved = await cache.open(options.key);
        if (!saved) throw new Error('The browser removed the saved installation.');
        await options.load(saved);
        resetSelection();
        cachedInstallation = saved;
        message(
          result.persistent
            ? 'Game files saved on this device. Ready to play.'
            : 'Game files saved. This browser may remove them when storage is low. Ready to play.',
        );
      }),
  );
  const remove = button(
    'Remove saved game files',
    () =>
      void run(async () => {
        await cache.remove(options.key);
        // A mounted OPFS File may no longer be readable after removal. Require a fresh selection.
        message(
          'Saved game files removed. Choose or open an installation to play. Browser saves are unchanged.',
        );
        options.clear();
        resetSelection();
        cachedInstallation = null;
      }),
  );
  const cancel = button('Cancel copy', () => abort?.abort());
  cancel.hidden = true;
  const help = document.createElement('p');
  help.textContent =
    'Add files or add one file at a time if your file manager cannot select several. Added files join the current selection; choosing a folder replaces it. Safari may copy selections temporarily. Keeping files in browser storage makes an optional persistent copy, separate from saves; the page itself still needs the server.';
  section.append(input, single, selectedDetails, help, status);
  function refresh(): void {
    const disabled = working || options.busy();
    options.choose.disabled = disabled;
    for (const button of controls) button.disabled = disabled;
    cancel.disabled = false;
    if (!cache.available()) {
      open.disabled = save.disabled = remove.disabled = true;
      status.textContent =
        'Persistent game files require HTTPS (or localhost) and browser file storage support. Device file selection is still available.';
    } else save.disabled ||= options.current() === null || options.current() === cachedInstallation;
  }
  refresh();
  return {refresh, resetSelection};
}

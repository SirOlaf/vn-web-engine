import {BlobSource, HttpSource} from './core/source.js';
import {CpkArchive} from './formats/cri/cpk.js';
import {SourceFileSystem} from './platform/filesystem.js';
import {windowsFileKey} from './platform/windows-filesystem.js';
import {openBrowserPlatform} from './platform/services.js';
import {NOAH_PATHS, NOAH_WINDOWS} from './engines/mages/games/chaos-head-noah/paths.js';
import {openNoahPlayer} from './engines/mages/games/chaos-head-noah/sc3/browser-player.js';
import {gameDirectoryFiles} from './game-directory.js';
import {mountGameViewer} from './viewer/game-viewer.js';

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
const textMode = element<HTMLSelectElement>('text-mode');
textMode.onchange = () => {
  try {
    player?.setTextMode(textMode.value === 'dom' ? 'dom' : 'native');
  } catch (error) {
    textMode.value = 'native';
    player?.setTextMode('native');
    report(error);
  }
};
const status = element('status'),
  sidebar = element('sidebar');
const {collapseOptions: collapse} = mountGameViewer('noah');
const files = element<HTMLInputElement>('files'),
  imported = element<HTMLInputElement>('save-import'),
  saveFile = element<HTMLSelectElement>('save-file'),
  play = element<HTMLButtonElement>('play');
const gameFiles = new SourceFileSystem(windowsFileKey),
  archives = new Map<string, CpkArchive>();
let platform: ReturnType<typeof openBrowserPlatform> | undefined,
  player: Awaited<ReturnType<typeof openNoahPlayer>> | undefined,
  busy = false,
  started = false;
const services = () =>
  (platform ??= openBrowserPlatform(
    'chaos-head-noah-gog',
    'default',
    gameFiles,
    NOAH_WINDOWS,
  ).catch((error) => {
    platform = undefined;
    throw error;
  }));
function report(error: unknown) {
  status.textContent = error instanceof Error ? error.message : String(error);
}
function sidebarAvailability(available: boolean) {
  if (sidebar.hidden === !available) return;
  const restoreFocus = !available && sidebar.contains(document.activeElement);
  if (!available) collapse(true);
  sidebar.hidden = !available;
  if (restoreFocus) player?.panel.querySelector('canvas')?.focus({preventScroll: true});
}
// Fullscreen the page so the game and its native-menu-gated sidebar stay together.
// Older WebKit exposes the same element fullscreen capability under prefixed names.
const fullscreenButton = element<HTMLButtonElement>('fullscreen');
const fullscreenDocument = document as Document & {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => void | Promise<void>;
};
const fullscreenRoot = document.documentElement as HTMLElement & {
  webkitRequestFullscreen?: () => void | Promise<void>;
};
const standardFullscreen =
  typeof fullscreenRoot.requestFullscreen === 'function' &&
  typeof document.exitFullscreen === 'function';
const prefixedFullscreen =
  typeof fullscreenRoot.webkitRequestFullscreen === 'function' &&
  typeof fullscreenDocument.webkitExitFullscreen === 'function';
const standardFullscreenAllowed = () => standardFullscreen && document.fullscreenEnabled !== false;
const prefixedFullscreenAllowed = () =>
  prefixedFullscreen && fullscreenDocument.webkitFullscreenEnabled !== false;
let fullscreenPending = false;
const isFullscreen = () =>
  !!(document.fullscreenElement ?? fullscreenDocument.webkitFullscreenElement);
function syncFullscreen() {
  const active = isFullscreen(),
    available = standardFullscreenAllowed() || prefixedFullscreenAllowed();
  fullscreenButton.textContent = active ? 'Exit fullscreen' : 'Enter fullscreen';
  fullscreenButton.setAttribute('aria-pressed', String(active));
  fullscreenButton.disabled = fullscreenPending || (!active && !available);
  const help = element('fullscreen-help');
  help.hidden = active || available;
  help.textContent =
    standardFullscreen || prefixedFullscreen
      ? 'Fullscreen is blocked in this page or browser.'
      : 'This browser does not offer fullscreen for interactive pages.';
}
fullscreenButton.onclick = async () => {
  if (fullscreenPending) return;
  fullscreenPending = true;
  syncFullscreen();
  try {
    // Call directly in the click handler, before any await consumes user activation.
    if (isFullscreen()) {
      if (document.fullscreenElement && standardFullscreen) await document.exitFullscreen();
      else if (prefixedFullscreen) await fullscreenDocument.webkitExitFullscreen!();
      else await document.exitFullscreen();
    } else if (standardFullscreenAllowed()) await fullscreenRoot.requestFullscreen();
    else if (prefixedFullscreenAllowed()) await fullscreenRoot.webkitRequestFullscreen!();
  } catch (error) {
    report(error);
  } finally {
    fullscreenPending = false;
    syncFullscreen();
  }
};
for (const event of ['fullscreenchange', 'webkitfullscreenchange'])
  document.addEventListener(event, syncFullscreen);
for (const event of ['fullscreenerror', 'webkitfullscreenerror'])
  document.addEventListener(event, () => {
    report('The browser could not change fullscreen mode.');
    syncFullscreen();
  });
syncFullscreen();
function updateControls() {
  for (const id of ['connect', 'choose', 'import'])
    element<HTMLButtonElement>(id).disabled = busy || started;
  play.disabled = busy;
  element<HTMLButtonElement>('export').disabled = busy;
  saveFile.disabled = busy;
}
async function action(work: () => Promise<void>) {
  if (busy) return;
  busy = true;
  updateControls();
  try {
    await work();
  } catch (error) {
    report(error);
  } finally {
    busy = false;
    updateControls();
  }
}
function prepareLoad() {
  sidebarAvailability(true);
  play.hidden = true;
  player?.dispose();
  player = undefined;
}
async function ready() {
  if (!archives.has('script.cpk') || !archives.has('mes00.cpk'))
    throw new Error('Choose the game’s CPK archives, including script.cpk and mes00.cpk.');
  try {
    await gameFiles.stat('/Game.exe');
  } catch {
    throw new Error('Choose Game.exe as well, for the original game cursors.');
  }
  player?.dispose();
  player = undefined;
  player = await openNoahPlayer(
    await services(),
    (name) => archives.get(name.toLowerCase()),
    report,
    'game',
    sidebarAvailability,
  );
  player.setTextMode(textMode.value === 'dom' ? 'dom' : 'native');
  play.hidden = false;
  element('game-title').textContent = 'CHAOS;HEAD NOAH';
  element('prompt').textContent = 'CHAOS;HEAD NOAH is ready.';
  status.textContent = `${archives.size} archives loaded. Ready to play.`;
  collapse(true);
}
element<HTMLButtonElement>('connect').onclick = () =>
  void action(async () => {
    prepareLoad();
    archives.clear();
    const response = await fetch('/api/archives');
    if (!response.ok)
      throw new Error(
        'CHAOS;HEAD NOAH files were not found. Choose a folder or configure NOAH_DATA_ROOT on the local server.',
      );
    const entries: {name: string; size: number; url: string}[] = await response.json();
    const executable = await fetch('/api/executable');
    if (!executable.ok) throw new Error('Installed Game.exe was not found.');
    const exe: {size: number; url: string} = await executable.json();
    gameFiles.attach('/Game.exe', new HttpSource(exe.url, exe.size));
    for (const entry of entries) {
      status.textContent = `Opening ${entry.name}…`;
      const source = new HttpSource(entry.url, entry.size);
      const archive = await CpkArchive.open(source);
      gameFiles.attach('/Data/' + entry.name, source);
      archives.set(entry.name.toLowerCase(), archive);
    }
    await ready();
  });
element<HTMLButtonElement>('choose').onclick = () => files.click();
files.onchange = () =>
  void action(async () => {
    if (!files.files?.length) return;
    const selectedFiles = Array.from(files.files);
    files.value = '';
    const selected = gameDirectoryFiles(selectedFiles);
    prepareLoad();
    archives.clear();
    gameFiles.attach('/Game.exe', new BlobSource(selected.executable));
    for (const file of selected.archives) {
      const source = new BlobSource(file);
      status.textContent = `Opening ${file.name}…`;
      archives.set(file.name.toLowerCase(), await CpkArchive.open(source));
      gameFiles.attach('/Data/' + file.name, source);
    }
    await ready();
  });
play.onclick = () => {
  if (!player || busy || started) return;
  started = true;
  element('game').replaceChildren(player.panel);
  collapse(true);
  status.textContent = 'Game running.';
  element('save-help').textContent = 'Reload the page to import files before playing.';
  updateControls();
  player.start();
};
const savePaths: Record<string, string> = {
  saveData: NOAH_PATHS.saveData,
  config: NOAH_PATHS.config,
  padConfig: NOAH_PATHS.padConfig,
};
element<HTMLButtonElement>('import').onclick = () => imported.click();
imported.onchange = () =>
  void action(async () => {
    if (started) throw new Error('Reload the page before importing.');
    const file = imported.files?.[0];
    if (!file) return;
    const path = savePaths[saveFile.value];
    if (!path) throw new Error('Select a save file.');
    if (file.size > 64 * 1024 * 1024) throw new Error('Import exceeds 64 MiB.');
    await (
      await services()
    ).windowsFiles.commit([{kind: 'write', path, data: new Uint8Array(await file.arrayBuffer())}]);
    imported.value = '';
    status.textContent = `${path.split('\\').at(-1)} imported.`;
  });
element<HTMLButtonElement>('export').onclick = () =>
  void action(async () => {
    const path = savePaths[saveFile.value];
    if (!path) throw new Error('Select a save file.');
    const fs = (await services()).windowsFiles;
    let source;
    try {
      source = await fs.open(path);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'NOT_FOUND')
        throw new Error('This file has not been saved yet.');
      throw error;
    }
    const bytes = await source.read(0, source.size),
      url = URL.createObjectURL(new Blob([bytes.slice().buffer]));
    const link = document.createElement('a');
    link.href = url;
    link.download = path.split('\\').at(-1)!;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    status.textContent = `${link.download} exported.`;
  });
window.addEventListener('pagehide', (event) => {
  if (!event.persisted) player?.dispose();
});
if (new URLSearchParams(location.search).get('source') === 'installed')
  element<HTMLButtonElement>('connect').click();

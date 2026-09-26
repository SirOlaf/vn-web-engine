import {BlobSource} from '../../src/core/source.js';
import {CpkArchive} from '../../src/formats/cri/cpk.js';
import {SourceFileSystem} from '../../src/platform/filesystem.js';
import {windowsFileKey} from '../../src/platform/windows-filesystem.js';
import {openBrowserPlatform} from '../../src/platform/services.js';
import {NOAH_WINDOWS} from '../../src/engines/mages/games/chaos-head-noah/paths.js';
import {openNoahPlayer} from '../../src/engines/mages/games/chaos-head-noah/sc3/browser-player.js';
import {mountInstallationControls} from '../player/installation-controls.js';
import type {CachedInstallation, InstallationFile} from '../../src/platform/installation-cache.js';
import type {InstallationSelection} from '../../src/platform/installation-picker.js';
import {mountGameViewer} from '../player/game-viewer.js';
import {setRuntimeState, subscribeSaveBusy} from '../player/runtime-state.js';
import {mountFullscreenControls} from '../player/fullscreen.js';
import {BrowserPageFullscreenHost} from '../../src/platform/browser-page-fullscreen.js';

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
let fullscreenControls: ReturnType<typeof mountFullscreenControls> | undefined;
const displayHost = new BrowserPageFullscreenHost(
  element('display'),
  () => fullscreenControls?.refresh(),
  report,
);
fullscreenControls = mountFullscreenControls(displayHost);
const files = element<HTMLInputElement>('files'),
  play = element<HTMLButtonElement>('play');
const gameFiles = new SourceFileSystem(windowsFileKey),
  archives = new Map<string, CpkArchive>();
let platform: ReturnType<typeof openBrowserPlatform> | undefined,
  player: Awaited<ReturnType<typeof openNoahPlayer>> | undefined,
  busy = false,
  started = false,
  saveBusy = false;
let selectedInstallation: CachedInstallation | null = null;
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
function updateControls() {
  setRuntimeState({running: started, busy});
  play.disabled = busy || started || saveBusy || !player;
  installationControls.refresh();
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
async function loadInstallation(installation: CachedInstallation): Promise<void> {
  const byPath = new Map(installation.files.map((entry) => [entry.path.toLowerCase(), entry]));
  if (!byPath.has('/game.exe') || !byPath.has('/data/script.cpk') || !byPath.has('/data/mes00.cpk'))
    throw new Error(
      'Choose Game.exe and Data/*.cpk, including script.cpk and mes00.cpk. Add the executable and archives in separate selections if needed.',
    );
  prepareLoad();
  selectedInstallation = null;
  archives.clear();
  gameFiles.clear();
  gameFiles.attach('/Game.exe', byPath.get('/game.exe')!.source);
  for (const entry of installation.files) {
    if (!/^\/data\/[^/]+\.cpk$/i.test(entry.path)) continue;
    const name = entry.path.split('/').at(-1)!;
    status.textContent = `Opening ${name}…`;
    archives.set(name.toLowerCase(), await CpkArchive.open(entry.source));
    gameFiles.attach(entry.path, entry.source);
  }
  await ready();
  selectedInstallation = installation;
}
async function selectInstallation(selection: InstallationSelection): Promise<void> {
  prepareLoad();
  selectedInstallation = null;
  const files: InstallationFile[] = [];
  for (const {path, file} of selection.files) {
    if (path.toLowerCase() !== '/game.exe' && !/^\/data\/[^/]+\.cpk$/i.test(path)) continue;
    files.push({
      path,
      source: new BlobSource(file),
      lastModifiedMs: file.lastModified,
    });
  }
  await loadInstallation({files, metadata: {}, attachments: {}});
}
const installationControls = mountInstallationControls({
  key: 'chaos-head-noah-gog',
  choose: element<HTMLButtonElement>('choose'),
  input: files,
  current: () => selectedInstallation,
  canonicalPath: windowsFileKey,
  selectedPath: (path, directory) => (!directory && /\.cpk$/i.test(path) ? '/Data' + path : path),
  busy: () => busy || started || saveBusy,
  setBusy: (value) => {
    busy = value;
    updateControls();
  },
  report,
  select: selectInstallation,
  load: loadInstallation,
  clear: () => {
    prepareLoad();
    selectedInstallation = null;
    archives.clear();
    gameFiles.clear();
  },
});
play.onclick = () => {
  if (!player || busy || saveBusy || started) return;
  started = true;
  element('welcome').hidden = true;
  element('noah-surface').replaceChildren(player.panel);
  collapse(true);
  status.textContent = 'Game running.';
  updateControls();
  player.start();
};
subscribeSaveBusy((value) => {
  saveBusy = value;
  updateControls();
});
window.addEventListener('pagehide', (event) => {
  if (!event.persisted) {
    player?.dispose();
    displayHost.dispose();
    fullscreenControls?.destroy();
    void platform?.then((services) => services.close()).catch(() => {});
  }
});

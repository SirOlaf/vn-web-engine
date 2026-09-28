import {BlobSource, type ByteSource} from '../../src/core/source.js';
import {IndexedDbStore} from '../../src/platform/store.js';
import type {CachedInstallation, InstallationFile} from '../../src/platform/installation-cache.js';
import type {InstallationSelection} from '../../src/platform/installation-picker.js';
import {BrowserPageFullscreenHost} from '../../src/platform/browser-page-fullscreen.js';
import {
  findExecutableApini,
  parseApini,
  type RScriptApini,
} from '../../src/engines/rscript/apini.js';
import {RScriptFiles, rscriptPathSegments} from '../../src/engines/rscript/files.js';
import {RScriptBrowserPlayer} from '../../src/engines/rscript/browser/player.js';
import type {RScriptSaveStorage} from '../../src/engines/rscript/runtime/game.js';
import {mountInstallationControls} from '../player/installation-controls.js';
import {mountGameViewer} from '../player/game-viewer.js';
import {setRuntimeState, subscribeSaveBusy} from '../player/runtime-state.js';
import {mountFullscreenControls} from '../player/fullscreen.js';
import {
  RSCRIPT_INSTALLATION_KEY,
  activeRScriptGame,
  rscriptPathKey,
  rscriptSaveNamespace,
} from '../player/rscript-library.js';

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
const status = element('status'),
  sidebar = element('sidebar'),
  surface = element('rscript-surface'),
  play = element<HTMLButtonElement>('play');
const {collapseOptions: collapse} = mountGameViewer('rscript');
const textMode = element<HTMLSelectElement>('text-mode');
const selectedTextMode = (): 'native' | 'dom' => (textMode.value === 'dom' ? 'dom' : 'native');
textMode.onchange = () => player?.setTextMode(selectedTextMode());
let fullscreenControls: ReturnType<typeof mountFullscreenControls> | undefined;
const displayHost = new BrowserPageFullscreenHost(
  element('display'),
  () => fullscreenControls?.refresh(),
  report,
);
fullscreenControls = mountFullscreenControls(displayHost);

interface Installation {
  apini: RScriptApini;
  files: RScriptFiles;
  saves: IndexedDbStore;
}
let installation: Installation | null = null,
  player: RScriptBrowserPlayer | null = null,
  selectedInstallation: CachedInstallation | null = null,
  busy = false,
  started = false,
  saveBusy = false;

function report(error: unknown): void {
  status.textContent = error instanceof Error ? error.message : String(error);
}
function updateControls(): void {
  setRuntimeState({running: started, busy});
  play.disabled = busy || started || saveBusy || !installation;
  installationControls.refresh();
}
function closeInstallation(): void {
  player?.dispose();
  player = null;
  installation?.saves.close();
  installation = null;
  activeRScriptGame.set(null);
}

/** Identifies the codeX RScript executable by its APINI block; RsInit.cfg overrides it. */
async function identify(files: ReadonlyMap<string, ByteSource>): Promise<RScriptApini> {
  const config = files.get('RSINIT.CFG');
  if (config) return parseApini(await config.read(0, config.size));
  for (const [path, source] of files) {
    if (path.includes('\\') || !path.endsWith('.EXE')) continue;
    try {
      return findExecutableApini(await source.read(0, source.size));
    } catch {
      // Not the game executable (for example an uninstaller); keep looking.
    }
  }
  throw new Error('Choose the game folder, including the game executable (.exe).');
}

function storage(store: IndexedDbStore): RScriptSaveStorage {
  return {
    read: async (name) => (await store.snapshot()).get(name.toUpperCase()) ?? null,
    write: (name, bytes) =>
      store.update((records) => void records.set(name.toUpperCase(), bytes.slice())),
  };
}

async function loadInstallation(cached: CachedInstallation): Promise<void> {
  closeInstallation();
  selectedInstallation = null;
  const byPath = new Map<string, ByteSource>();
  for (const entry of cached.files) {
    try {
      byPath.set(rscriptPathSegments(entry.path).join('\\'), entry.source);
    } catch {
      // Paths outside the installation tree are not game resources.
    }
  }
  const apini = await identify(byPath);
  const files = new RScriptFiles((segments) => byPath.get(segments.join('\\')));
  const namespace = rscriptSaveNamespace(apini);
  const saves = await IndexedDbStore.open(namespace);
  installation = {apini, files, saves};
  activeRScriptGame.set({title: apini.title, savePrefix: apini.savePrefix, namespace});
  document.title = `${apini.title} · VN Web Engine`;
  element('game-title').textContent = apini.title;
  element('prompt').textContent = `${apini.title} is ready.`;
  status.textContent = `${byPath.size} files found. Ready to play.`;
  play.hidden = false;
  selectedInstallation = cached;
  collapse(true);
}

async function selectInstallation(selection: InstallationSelection): Promise<void> {
  const files: InstallationFile[] = selection.files.map(({path, file}) => ({
    path,
    source: new BlobSource(file),
    lastModifiedMs: file.lastModified,
  }));
  await loadInstallation({
    directories: selection.directories,
    files,
    metadata: {},
    attachments: {},
  });
}

const installationControls = mountInstallationControls({
  key: RSCRIPT_INSTALLATION_KEY,
  choose: element<HTMLButtonElement>('choose'),
  input: element<HTMLInputElement>('files'),
  current: () => selectedInstallation,
  canonicalPath: rscriptPathKey,
  busy: () => busy || started || saveBusy,
  setBusy: (value) => {
    busy = value;
    updateControls();
  },
  report,
  select: selectInstallation,
  load: loadInstallation,
  clear: () => {
    closeInstallation();
    selectedInstallation = null;
  },
});

function stopped(error?: unknown): void {
  started = false;
  player?.dispose();
  player = null;
  surface.replaceChildren();
  element('welcome').hidden = false;
  const message =
    error === undefined
      ? 'The game closed.'
      : `The game stopped: ${error instanceof Error ? error.message : error}`;
  element('prompt').textContent = message;
  report(message);
  if (error !== undefined) console.error(error);
  updateControls();
}

play.onclick = () => {
  if (!installation || busy || saveBusy || started) return;
  const {apini, files, saves} = installation;
  started = true;
  player = new RScriptBrowserPlayer({
    files,
    apini,
    saves: storage(saves),
    document,
    diagnostic: (message) => console.warn(`[RScript] ${message}`),
    exit: stopped,
  });
  element('welcome').hidden = true;
  surface.replaceChildren(player.panel);
  player.setTextMode(selectedTextMode());
  sidebar.hidden = false;
  collapse(true);
  status.textContent = `${apini.title} is running.`;
  updateControls();
  player.start();
};
subscribeSaveBusy((value) => {
  saveBusy = value;
  updateControls();
});
window.addEventListener('pagehide', (event) => {
  if (!event.persisted) {
    closeInstallation();
    displayHost.dispose();
    fullscreenControls?.destroy();
  }
});

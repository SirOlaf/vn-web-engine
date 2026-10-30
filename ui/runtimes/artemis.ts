import {BlobSource, type ByteSource} from '../../src/core/source.js';
import {IndexedDbStore} from '../../src/platform/store.js';
import type {CachedInstallation, InstallationFile} from '../../src/platform/installation-cache.js';
import type {InstallationSelection} from '../../src/platform/installation-picker.js';
import {BrowserPageFullscreenHost} from '../../src/platform/browser-page-fullscreen.js';
import {pfsPathKey} from '../../src/formats/artemis/pfs.js';
import {ArtemisFiles} from '../../src/engines/artemis/files.js';
import {artemisRevision} from '../../src/engines/artemis/revision.js';
import {ArtemisBrowserPlayer} from '../../src/engines/artemis/browser/player.js';
import type {ArtemisRuntimeStorage} from '../../src/engines/artemis/runtime.js';
import {mountInstallationControls} from '../player/installation-controls.js';
import {mountGameViewer} from '../player/game-viewer.js';
import {setRuntimeState, subscribeSaveBusy} from '../player/runtime-state.js';
import {mountFullscreenControls} from '../player/fullscreen.js';
import {
  activeArtemisGame,
  artemisSaveNamespace,
  rememberArtemisGame,
} from '../player/artemis-library.js';
import {rememberLastPlayed} from '../player/last-played.js';
import {prepareArtemisLuaCompatibility} from '../game-profiles/artemis.js';

/** The Windows version this page reports to games (Windows 10, 10.0). Games that check the
 * version see a supported system instead of the unknown one a browser would report. */
const REPORTED_WINDOWS_VERSION = {major: 10, minor: 0};
/** The WebGL 2 renderer implements the engine's Direct3D 11 path, so the page reports
 * D3D_FEATURE_LEVEL_11_0. */
const REPORTED_GRAPHICS_FEATURE_LEVEL = 0xb000;

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
const status = element('status'),
  sidebar = element('sidebar'),
  surface = element('artemis-surface'),
  play = element<HTMLButtonElement>('play');
const {collapseOptions: collapse} = mountGameViewer('artemis');
const textMode = element<HTMLSelectElement>('text-mode');
const selectedTextMode = (): 'native' | 'dom' => (textMode.value === 'dom' ? 'dom' : 'native');
textMode.onchange = () => player?.setTextMode(selectedTextMode());
let fullscreenControls: ReturnType<typeof mountFullscreenControls> | undefined;
const displayHost = new BrowserPageFullscreenHost(
  element('display'),
  () => {
    fullscreenControls?.refresh();
    player?.relayout();
  },
  report,
);
fullscreenControls = mountFullscreenControls(displayHost);

interface Installation {
  executableSha256: string;
  luaSourceOverrides: ReadonlyMap<string, Uint8Array>;
  files: ArtemisFiles;
  paths: ReadonlySet<string>;
  saves: IndexedDbStore;
}
let installation: Installation | null = null,
  player: ArtemisBrowserPlayer | null = null,
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
  activeArtemisGame.set(null);
}

async function sha256(source: ByteSource): Promise<string> {
  const bytes = await source.read(0, source.size);
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Identifies the engine revision by the hash of a root executable. */
async function identify(
  files: ReadonlyMap<string, ByteSource>,
): Promise<{executableSha256: string; executableName: string}> {
  const hashes: string[] = [];
  for (const [path, source] of files) {
    if (path.includes('/') || !/\.exe$/i.test(path)) continue;
    const hash = await sha256(source);
    try {
      artemisRevision(hash);
      return {executableSha256: hash, executableName: path};
    } catch {
      hashes.push(hash);
    }
  }
  if (hashes.length) throw new Error('This Artemis executable revision is not supported yet.');
  throw new Error('Choose the game folder, including the game executable (.exe).');
}

function storage(store: IndexedDbStore): ArtemisRuntimeStorage {
  return {
    read: async (name) => (await store.snapshot()).get(name) ?? null,
    write: (name, bytes) => store.update((records) => void records.set(name, bytes.slice())),
    list: async () => [...(await store.snapshot()).keys()],
    delete: (name) => store.update((records) => void records.delete(name)),
  };
}

async function loadInstallation(cached: CachedInstallation): Promise<void> {
  closeInstallation();
  selectedInstallation = null;
  const byPath = new Map<string, ByteSource>();
  // Installation paths are rooted ('/hatsuyuki.pfs'); archive names are relative.
  for (const entry of cached.files)
    byPath.set(pfsPathKey(entry.path).replace(/^\/+/, ''), entry.source);
  const bases = [...byPath.keys()].filter((path) => !path.includes('/') && /\.pfs$/.test(path));
  if (bases.length !== 1)
    throw new Error('Choose the game folder, including its base .pfs archive.');
  const {executableSha256, executableName} = await identify(byPath);
  const files = await ArtemisFiles.mount(bases[0]!, (segments) => byPath.get(segments.join('/')));
  const luaSourceOverrides = await prepareArtemisLuaCompatibility(executableSha256, (path) =>
    files.read(path),
  );
  const paths = new Set(byPath.keys());
  for (const {archive} of files.archives)
    for (const entry of archive.entries) paths.add(pfsPathKey(entry.name));
  const namespace = artemisSaveNamespace(executableSha256, bases[0]!);
  const saves = await IndexedDbStore.open(namespace);
  installation = {executableSha256, luaSourceOverrides, files, paths, saves};
  // The executable carries no product name, so the game is named by its folder.
  const title = cached.metadata.title || executableName.replace(/\.exe$/i, '');
  const game = {title, namespace};
  activeArtemisGame.set(game);
  void rememberArtemisGame(game).catch(() => undefined);
  rememberLastPlayed('artemis', title);
  document.title = `${title} · VN Web Engine`;
  element('game-title').textContent = title;
  element('prompt').textContent = 'The game is ready.';
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
  const folder =
    selection.directoryHandle?.name ||
    selection.files
      .find(({file}) => file.webkitRelativePath)
      ?.file.webkitRelativePath.split('/')[0];
  await loadInstallation({
    directories: selection.directories,
    files,
    metadata: folder ? {title: folder} : {},
    attachments: {},
  });
}

const installationControls = mountInstallationControls({
  player: 'artemis',
  choose: element<HTMLButtonElement>('choose'),
  input: element<HTMLInputElement>('files'),
  current: () => selectedInstallation,
  canonicalPath: pfsPathKey,
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

function stopped(error: unknown): void {
  started = false;
  player?.dispose();
  player = null;
  surface.replaceChildren();
  element('welcome').hidden = false;
  const message = `The game stopped: ${error instanceof Error ? error.message : error}`;
  element('prompt').textContent = message;
  report(message);
  console.error(error);
  updateControls();
}

/** `#trace` in the page address keeps the last runtime tags and effects in
 * `window.artemisTrace` for diagnostics. */
function pageTrace() {
  if (!location.hash.includes('trace')) return undefined;
  const entries: unknown[] = [];
  // Latest lyevent registration per layer and event type.
  const events = new Map<string, Record<string, string>>();
  // Tag counts, and save, load, selection, reset, video and music tags and mode changes in order.
  const counts = new Map<string, number>();
  const notable: unknown[] = [];
  // Every entry carries the page time in milliseconds.
  const push = (entry: object) => {
    entries.push({t: Math.round(performance.now()), ...entry});
    if (entries.length > 400) entries.splice(0, 200);
  };
  Object.assign(window, {
    artemisTrace: {
      entries,
      events: () => Object.fromEntries(events),
      counts: () => Object.fromEntries(counts),
      notable,
      saves: async () =>
        [...((await installation?.saves.snapshot()) ?? [])].map(([name, bytes]) => [
          name,
          bytes.byteLength,
        ]),
      state: () => player?.state ?? null,
      hitTest: (x: number, y: number) => player?.hitTest(x, y) ?? [],
      lua: (path: string) => player?.luaValue(path) ?? null,
    },
  });
  return {
    tag: (tag: {name: string; args: ReadonlyMap<string, string>}) => {
      const args = Object.fromEntries(tag.args);
      if (tag.name === 'lyevent') events.set(`${args.id} ${args.type}`, args);
      counts.set(tag.name, (counts.get(tag.name) ?? 0) + 1);
      if (
        /save|load|sel|reset|video|movie|bgm|exit|^print$/i.test(tag.name) &&
        notable.length < 2000
      )
        notable.push({t: Math.round(performance.now()), tag: tag.name, args});
      push({tag: tag.name, args});
    },
    effect: (effect: object) => {
      // Skip and automode changes and click glyph placement join the ordered notable list.
      if (
        ['automode', 'commandSkip', 'controlSkip', 'clickGlyph'].some((key) => key in effect) &&
        notable.length < 2000
      )
        notable.push({t: Math.round(performance.now()), effect});
      push(effect);
    },
    script: (step: object) => push({step}),
  };
}

play.onclick = () => {
  if (!installation || busy || saveBusy || started) return;
  const {executableSha256, luaSourceOverrides, files, paths, saves} = installation;
  started = true;
  player = new ArtemisBrowserPlayer({
    document,
    executableSha256,
    luaSourceOverrides,
    files,
    paths,
    storage: storage(saves),
    windowsVersion: REPORTED_WINDOWS_VERSION,
    graphicsFeatureLevel: REPORTED_GRAPHICS_FEATURE_LEVEL,
    display: displayHost,
    trace: pageTrace(),
    readAhead: !location.hash.includes('noreadahead'),
    diagnostic: (message) => console.warn(`[Artemis] ${message}`),
    exit: stopped,
    closed: () => {
      started = false;
      player?.dispose();
      player = null;
      surface.replaceChildren();
      element('welcome').hidden = false;
      element('prompt').textContent = 'The game closed.';
      report('The game closed.');
      updateControls();
    },
  });
  player.setTextMode(selectedTextMode());
  element('welcome').hidden = true;
  surface.replaceChildren(player.panel);
  sidebar.hidden = false;
  collapse(true);
  status.textContent = 'The game is running.';
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

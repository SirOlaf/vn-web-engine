import {SourceFileSystem} from '../src/platform/filesystem.js';
import {openBrowserPlatform} from '../src/platform/services.js';
import {windowsFileKey} from '../src/platform/windows-filesystem.js';
import {BrowserInstallationCache} from '../src/platform/installation-cache.js';
import {NOAH_PATHS, NOAH_WINDOWS} from '../src/engines/mages/games/chaos-head-noah/paths.js';

export type GameId = 'aokana' | 'noah';
export interface InstallationStatus {
  ready: boolean;
  detail: string;
}

export async function installationStatus(game: GameId): Promise<InstallationStatus> {
  try {
    const cached = await new BrowserInstallationCache().open(
      game === 'aokana' ? 'aokana' : 'chaos-head-noah-gog',
    );
    if (!cached) return {ready: false, detail: 'Choose the game folder in the player.'};
    const title = game === 'aokana' ? 'game files' : 'game archives';
    return {ready: true, detail: `${cached.files.length} ${title} saved in this browser`};
  } catch {
    return {ready: false, detail: 'Choose the game folder in the player.'};
  }
}

export const noahSaveFiles = [
  {id: 'saveData', name: 'SAVEDATA.DAT', path: NOAH_PATHS.saveData},
  {id: 'config', name: 'CONFIG.DAT', path: NOAH_PATHS.config},
  {id: 'padConfig', name: 'PADCONFIG.DAT', path: NOAH_PATHS.padConfig},
] as const;

async function withNoahFiles<T>(
  work: (files: Awaited<ReturnType<typeof openBrowserPlatform>>['windowsFiles']) => Promise<T>,
): Promise<T> {
  const platform = await openBrowserPlatform(
    'chaos-head-noah-gog',
    'default',
    new SourceFileSystem(windowsFileKey),
    NOAH_WINDOWS,
  );
  try {
    return await work(platform.windowsFiles);
  } finally {
    platform.close();
  }
}

export async function readNoahSave(id: string): Promise<Uint8Array> {
  const file = noahSaveFiles.find((entry) => entry.id === id);
  if (!file) throw new Error('Select a save file.');
  return withNoahFiles(async (files) => {
    const source = await files.open(file.path);
    return source.read(0, source.size);
  });
}

export async function writeNoahSave(id: string, bytes: Uint8Array): Promise<void> {
  const file = noahSaveFiles.find((entry) => entry.id === id);
  if (!file) throw new Error('Select a save file.');
  if (bytes.length > 64 * 1024 * 1024) throw new Error('Import exceeds 64 MiB.');
  await withNoahFiles((files) => files.commit([{kind: 'write', path: file.path, data: bytes}]));
}

export function downloadBytes(name: string, bytes: Uint8Array): void {
  const copy = bytes.slice();
  const url = URL.createObjectURL(new Blob([copy.buffer]));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

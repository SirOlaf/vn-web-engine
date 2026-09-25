import {SourceFileSystem} from '../src/platform/filesystem.js';
import {openBrowserPlatform} from '../src/platform/services.js';
import {windowsFileKey} from '../src/platform/windows-filesystem.js';
import {NOAH_PATHS, NOAH_WINDOWS} from '../src/engines/mages/games/chaos-head-noah/paths.js';

export type GameId = 'aokana' | 'noah';
export interface InstallationStatus {
  ready: boolean;
  detail: string;
}

export async function installationStatus(game: GameId): Promise<InstallationStatus> {
  try {
    if (game === 'aokana') {
      const [filesResponse, cursorResponse] = await Promise.all([
        fetch('/api/aokana/files'),
        fetch('/api/aokana/cursor', {method: 'HEAD'}),
      ]);
      if (!filesResponse.ok || !cursorResponse.ok)
        return {ready: false, detail: 'Choose an installation folder in the player.'};
      const files: {name?: string}[] = await filesResponse.json();
      if (!Array.isArray(files) || !files.some((file) => file.name?.toLowerCase() === 'system.arc'))
        return {ready: false, detail: 'The local installation needs system.arc.'};
      return {ready: true, detail: `${files.length} game files available on this device`};
    }
    const [archivesResponse, executableResponse] = await Promise.all([
      fetch('/api/archives'),
      fetch('/api/executable'),
    ]);
    if (!archivesResponse.ok || !executableResponse.ok)
      return {ready: false, detail: 'Choose an installation folder in the player.'};
    const archives: {name?: string}[] = await archivesResponse.json();
    if (
      !Array.isArray(archives) ||
      !['script.cpk', 'mes00.cpk'].every((required) =>
        archives.some((archive) => archive.name?.toLowerCase() === required),
      )
    )
      return {ready: false, detail: 'The local installation needs its game archives.'};
    return {ready: true, detail: `${archives.length} archives available on this device`};
  } catch {
    return {ready: false, detail: 'The local installation could not be checked.'};
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

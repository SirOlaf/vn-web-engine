import type {RecordStore} from './store.js';
import {IndexedDbStore, MemoryStore} from './store.js';
import {MountedFileSystem, SourceFileSystem, StoredFileSystem} from './filesystem.js';
import type {FileSystem} from './filesystem.js';
import {StoredRegistry} from './registry.js';
import type {Registry} from './registry.js';
import {WindowsFileSystem, windowsFileKey} from './windows-filesystem.js';
import type {WindowsPathOptions} from './windows-filesystem.js';
export interface PlatformServices {
  hostState?: RecordStore;
  files: FileSystem;
  windowsFiles: WindowsFileSystem;
  registry: Registry;
}
export async function openBrowserPlatform(
  gameId: string,
  profileId: string,
  game: SourceFileSystem = new SourceFileSystem(windowsFileKey),
  windows: WindowsPathOptions = {
    cwd: 'C:\\Game',
    mounts: [
      {windows: 'C:\\Game', virtual: '/game'},
      {windows: 'C:\\UserData', virtual: '/user'},
      {windows: 'T:\\', virtual: '/temp'},
    ],
    driveDirectories: {'T:': 'T:\\'},
  },
): Promise<PlatformServices & {close(): void}> {
  const store = await IndexedDbStore.open([gameId, profileId]),
    temporary = new MemoryStore(),
    files = new MountedFileSystem();
  files.mount('/game', game);
  files.mount('/user', new StoredFileSystem(store, windowsFileKey));
  files.mount('/temp', new StoredFileSystem(temporary, windowsFileKey));
  try {
    return {
      hostState: store,
      files,
      windowsFiles: new WindowsFileSystem(files, windows),
      registry: new StoredRegistry(store),
      close: () => {
        store.close();
        temporary.close();
      },
    };
  } catch (error) {
    store.close();
    temporary.close();
    throw error;
  }
}

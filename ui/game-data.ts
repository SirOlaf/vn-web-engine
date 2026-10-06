import {StoredFileSystem, type FileInfo} from '../src/platform/filesystem.js';
import {IndexedDbStore} from '../src/platform/store.js';
import {windowsFileKey} from '../src/platform/windows-filesystem.js';
import {burikoRegistryFold} from '../src/engines/buriko/native/registry-case.js';
import {burikoSavedGames, loadBurikoSavedGames} from './player/buriko-library.js';
import {knownRScriptGames, type RScriptActiveGame} from './player/rscript-library.js';
import type {PlayerId} from './players/registry.js';
import {get} from 'svelte/store';

/** A file a game keeps in this browser, at the Windows path the game sees. */
export interface GameDataFile {
  readonly path: string;
  readonly size: number;
}

/** A game the browser holds data for, with every file it stores. */
export interface KnownGame {
  readonly id: string;
  readonly title: string;
  /** The directories files can be added to, shown even while empty. */
  readonly directories: readonly string[];
  list(): Promise<GameDataFile[]>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  remove(paths: readonly string[]): Promise<void>;
}

const MAX_WRITE_BYTES = 64 * 1024 * 1024;

/** A stored file system shown under a Windows directory. */
interface StoredRoot {
  readonly windows: string;
  readonly namespace: readonly string[];
  readonly fold: (path: string) => string;
  /** Directory inside the store that holds the root's files; empty for the store root. */
  readonly inner: string;
}

async function withRoot<T>(
  root: StoredRoot,
  work: (files: StoredFileSystem) => Promise<T>,
): Promise<T> {
  const store = await IndexedDbStore.open(root.namespace);
  try {
    return await work(new StoredFileSystem(store, root.fold));
  } finally {
    store.close();
  }
}

async function walk(files: StoredFileSystem, directory: string): Promise<FileInfo[]> {
  const found: FileInfo[] = [];
  let entries: FileInfo[];
  try {
    entries = await files.list(directory);
  } catch {
    return found; // The root directory has not been written yet.
  }
  for (const entry of entries)
    if (entry.kind === 'directory') found.push(...(await walk(files, entry.path)));
    else found.push(entry);
  return found;
}

function locate(roots: readonly StoredRoot[], path: string): [StoredRoot, string] {
  for (const root of roots)
    if (path.toUpperCase().startsWith(root.windows.toUpperCase() + '\\'))
      return [root, `${root.inner}/${path.slice(root.windows.length + 1).replaceAll('\\', '/')}`];
  throw new Error(`${path} is outside the game's data.`);
}

function storedGame(id: string, title: string, roots: readonly StoredRoot[]): KnownGame {
  return {
    id,
    title,
    directories: roots.map((root) => root.windows.toUpperCase()),
    async list() {
      const files: GameDataFile[] = [];
      for (const root of roots)
        await withRoot(root, async (stored) => {
          const inner = root.fold(root.inner);
          for (const entry of await walk(stored, root.inner || '/'))
            files.push({
              // Stored names are folded; the root is shown folded alike.
              path:
                root.windows.toUpperCase() + entry.path.slice(inner.length).replaceAll('/', '\\'),
              size: entry.size,
            });
        });
      return files;
    },
    read(path) {
      const [root, inner] = locate(roots, path);
      return withRoot(root, async (stored) => {
        const source = await stored.open(inner);
        return source.read(0, source.size);
      });
    },
    write(path, bytes) {
      if (bytes.length > MAX_WRITE_BYTES) throw new Error('Import exceeds 64 MiB.');
      const [root, inner] = locate(roots, path);
      return withRoot(root, (stored) => stored.commit([{kind: 'write', path: inner, data: bytes}]));
    },
    async remove(paths) {
      for (const root of roots) {
        const inner = paths
          .map((path) => locate(roots, path))
          .filter(([owner]) => owner === root)
          .map(([, path]) => ({kind: 'delete' as const, path}));
        if (inner.length) await withRoot(root, (stored) => stored.commit(inner));
      }
    },
  };
}

/** RScript titles keep their saves as flat records named like the files in the game folder. */
function rscriptGame(id: string, title: string, namespace: readonly string[]): KnownGame {
  const folder = 'C:\\GAME';
  const name = (path: string): string => {
    if (!path.toUpperCase().startsWith(folder.toUpperCase() + '\\') || path.includes('\\', 8))
      throw new Error(`${path} is outside the game's data.`);
    return path.slice(folder.length + 1).toUpperCase();
  };
  const withStore = async <T>(work: (store: IndexedDbStore) => Promise<T>): Promise<T> => {
    const store = await IndexedDbStore.open(namespace);
    try {
      return await work(store);
    } finally {
      store.close();
    }
  };
  return {
    id,
    title,
    directories: [folder],
    list: () =>
      withStore(async (store) =>
        [...(await store.snapshot())].map(([key, bytes]) => ({
          path: `${folder}\\${key}`,
          size: bytes.length,
        })),
      ),
    read: (path) =>
      withStore(async (store) => {
        const bytes = (await store.snapshot()).get(name(path));
        if (!bytes) throw new Error('This file has not been saved yet.');
        return bytes;
      }),
    write(path, bytes) {
      if (bytes.length > MAX_WRITE_BYTES) throw new Error('Import exceeds 64 MiB.');
      const key = name(path);
      return withStore((store) => store.update((records) => void records.set(key, bytes.slice())));
    },
    remove(paths) {
      const keys = paths.map(name);
      return withStore((store) =>
        store.update((records) => {
          for (const key of keys) records.delete(key);
        }),
      );
    },
  };
}

/** Namespaces of the stores this browser holds, or null where the browser cannot list them. */
async function storedNamespaces(): Promise<string[][] | null> {
  if (typeof indexedDB.databases !== 'function') return null;
  const namespaces: string[][] = [];
  for (const {name} of await indexedDB.databases()) {
    if (!name?.startsWith('vn-runtime:')) continue;
    try {
      const value: unknown = JSON.parse(name.slice('vn-runtime:'.length));
      if (Array.isArray(value) && value.every((part) => typeof part === 'string'))
        namespaces.push(value);
    } catch {
      // Not a runtime store.
    }
  }
  return namespaces;
}

const sameNamespace = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((part, i) => part === right[i]);

/** The games of a player that have been loaded in this browser. */
export async function knownGames(player: PlayerId): Promise<KnownGame[]> {
  const stored = await storedNamespaces();
  const holds = (namespace: readonly string[]): boolean =>
    stored?.some((candidate) => sameNamespace(candidate, namespace)) ?? true;
  switch (player) {
    case 'buriko': {
      // Reading the library only where it exists keeps listing from creating it.
      if (holds(['buriko', 'library'])) await loadBurikoSavedGames().catch(() => undefined);
      return get(burikoSavedGames)
        .filter((game) => holds([...game.namespace, 'game']) || holds([...game.namespace, 'user']))
        .map((game) =>
          storedGame(game.id, game.title, [
            {
              windows: 'C:\\Game',
              namespace: [...game.namespace, 'game'],
              fold: burikoRegistryFold,
              inner: '',
            },
            {
              windows: 'C:\\UserData',
              namespace: [...game.namespace, 'user'],
              fold: burikoRegistryFold,
              inner: '',
            },
          ]),
        );
    }
    case 'rscript': {
      // Reading the library only where it exists keeps listing from creating it.
      const games = holds(['library', 'rscript'])
        ? await knownRScriptGames().catch((): RScriptActiveGame[] => [])
        : [];
      // Titles loaded before the library remembered them are named by their save prefix.
      for (const namespace of stored ?? [])
        if (
          namespace.length === 2 &&
          namespace[0] === 'rscript' &&
          !games.some((game) => sameNamespace(game.namespace, namespace))
        )
          games.push({title: namespace[1]!, savePrefix: namespace[1]!, namespace});
      return games
        .filter((game) => holds(game.namespace))
        .map((game) => rscriptGame(game.namespace.join('/'), game.title, game.namespace));
    }
    case 'chaos-head-noah': {
      const namespace = ['chaos-head-noah-gog', 'default'];
      if (!holds(namespace)) return [];
      return [
        storedGame('chaos-head-noah', 'CHAOS;HEAD NOAH', [
          {windows: 'C:', namespace, fold: windowsFileKey, inner: '/drives/C'},
        ]),
      ];
    }
  }
}

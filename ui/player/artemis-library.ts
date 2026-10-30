import {writable} from 'svelte/store';
import {IndexedDbStore} from '../../src/platform/store.js';

/** Saves are kept per executable revision and base archive. */
export function artemisSaveNamespace(executableSha256: string, baseArchive: string): string[] {
  return ['artemis', executableSha256, baseArchive];
}

export interface ArtemisActiveGame {
  title: string;
  namespace: readonly string[];
}
/** The installation opened in the player, for the save file controls. */
export const activeArtemisGame = writable<ArtemisActiveGame | null>(null);

async function withSaves<T>(
  game: ArtemisActiveGame,
  work: (store: IndexedDbStore) => Promise<T>,
): Promise<T> {
  const store = await IndexedDbStore.open(game.namespace);
  try {
    return await work(store);
  } finally {
    store.close();
  }
}
export function listArtemisSaves(game: ArtemisActiveGame): Promise<string[]> {
  return withSaves(game, async (store) => [...(await store.snapshot()).keys()].sort());
}
export function readArtemisSave(game: ArtemisActiveGame, name: string): Promise<Uint8Array> {
  return withSaves(game, async (store) => {
    const bytes = (await store.snapshot()).get(name);
    if (!bytes) throw new Error('This file has not been saved yet.');
    return bytes;
  });
}
/** Save files keep the name the game wrote them under in its save directory. */
export function writeArtemisSave(
  game: ArtemisActiveGame,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  if (!/^[^/\\]+$/.test(name)) throw new Error('Choose a save file from the game save folder.');
  return withSaves(game, (store) =>
    store.update((records) => void records.set(name, bytes.slice())),
  );
}

const LIBRARY = ['library', 'artemis'];

function validGame(value: unknown): value is ArtemisActiveGame {
  if (typeof value !== 'object' || value === null) return false;
  const game = value as Partial<ArtemisActiveGame>;
  return (
    typeof game.title === 'string' &&
    Array.isArray(game.namespace) &&
    game.namespace.length > 0 &&
    game.namespace.every((part) => typeof part === 'string' && part.length > 0)
  );
}

/** The Artemis installations loaded in this browser. */
export async function knownArtemisGames(): Promise<ArtemisActiveGame[]> {
  const store = await IndexedDbStore.open(LIBRARY);
  try {
    const games: ArtemisActiveGame[] = [];
    for (const bytes of (await store.snapshot()).values()) {
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (validGame(value)) games.push(value);
    }
    return games;
  } finally {
    store.close();
  }
}

export async function rememberArtemisGame(game: ArtemisActiveGame): Promise<void> {
  const store = await IndexedDbStore.open(LIBRARY);
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(game));
    await store.update((records) => void records.set(game.namespace.join('\0'), bytes));
  } finally {
    store.close();
  }
}

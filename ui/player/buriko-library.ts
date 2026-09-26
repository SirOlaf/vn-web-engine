import {writable} from 'svelte/store';
import {IndexedDbStore} from '../../src/platform/store.js';
import {legacyAokanaProfile} from '../game-profiles/aokana.js';

export interface BurikoSavedGame {
  readonly id: string;
  readonly title: string;
  readonly namespace: readonly string[];
}

export const burikoSavedGames = writable<BurikoSavedGame[]>([legacyAokanaProfile]);
export const activeBurikoGame = writable<BurikoSavedGame | null>(null);
export const burikoTitle = writable('BGI / Ethornell');

function valid(value: unknown): value is BurikoSavedGame {
  if (typeof value !== 'object' || value === null) return false;
  const game = value as Partial<BurikoSavedGame>;
  return (
    typeof game.id === 'string' &&
    typeof game.title === 'string' &&
    Array.isArray(game.namespace) &&
    game.namespace.length > 0 &&
    game.namespace.every(
      (part) => typeof part === 'string' && part.length > 0 && !part.includes('\0'),
    )
  );
}

export async function loadBurikoSavedGames(): Promise<void> {
  const store = await IndexedDbStore.open(['buriko', 'library']);
  try {
    const games: BurikoSavedGame[] = [legacyAokanaProfile];
    for (const bytes of (await store.snapshot()).values()) {
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (valid(value) && value.id !== legacyAokanaProfile.id) games.push(value);
    }
    burikoSavedGames.set(games);
  } finally {
    store.close();
  }
}

export async function rememberBurikoGame(game: BurikoSavedGame): Promise<void> {
  const store = await IndexedDbStore.open(['buriko', 'library']);
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(game));
    await store.update((records) => {
      records.set(game.id, bytes);
    });
  } finally {
    store.close();
  }
  await loadBurikoSavedGames();
}

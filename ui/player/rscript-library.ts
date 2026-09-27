import {writable} from 'svelte/store';
import type {RScriptApini} from '../../src/engines/rscript/apini.js';
import {IndexedDbStore} from '../../src/platform/store.js';

/** One remembered installation for codeX RScript titles. */
export const RSCRIPT_INSTALLATION_KEY = 'rscript';

/** Native paths fold ASCII letters only; Japanese file names keep their spelling. */
export function rscriptPathKey(path: string): string {
  return path.replace(/[a-z]/g, (c) => c.toUpperCase());
}

/** Saves are kept per title, keyed by the executable's save file prefix. */
export function rscriptSaveNamespace(apini: RScriptApini): string[] {
  return ['rscript', apini.savePrefix || apini.title];
}

export interface RScriptActiveGame {
  title: string;
  savePrefix: string;
  namespace: readonly string[];
}
/** The installation opened in the player, for the save file controls. */
export const activeRScriptGame = writable<RScriptActiveGame | null>(null);

/** Whether `name` is the system save or a numbered slot of the game (`FRsave.dat`, `FRsave01.dat`). */
export function isRScriptSaveName(game: RScriptActiveGame, name: string): boolean {
  const prefix = game.savePrefix.toUpperCase();
  const upper = name.toUpperCase();
  return upper.startsWith(prefix) && /^(\d{2})?\.DAT$/.test(upper.slice(prefix.length));
}

async function withSaves<T>(
  game: RScriptActiveGame,
  work: (store: IndexedDbStore) => Promise<T>,
): Promise<T> {
  const store = await IndexedDbStore.open(game.namespace);
  try {
    return await work(store);
  } finally {
    store.close();
  }
}
export function listRScriptSaves(game: RScriptActiveGame): Promise<string[]> {
  return withSaves(game, async (store) => [...(await store.snapshot()).keys()].sort());
}
export function readRScriptSave(game: RScriptActiveGame, name: string): Promise<Uint8Array> {
  return withSaves(game, async (store) => {
    const bytes = (await store.snapshot()).get(name.toUpperCase());
    if (!bytes) throw new Error('This file has not been saved yet.');
    return bytes;
  });
}
export function writeRScriptSave(
  game: RScriptActiveGame,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  if (!isRScriptSaveName(game, name))
    throw new Error(
      `Choose ${game.savePrefix}.dat or a numbered save such as ${game.savePrefix}01.dat.`,
    );
  return withSaves(game, (store) =>
    store.update((records) => void records.set(name.toUpperCase(), bytes.slice())),
  );
}

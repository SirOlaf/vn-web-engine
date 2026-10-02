import {
  BurikoSaveTransfer,
  type BurikoSaveEntry,
} from '../../../src/engines/buriko/save-transfer.js';
import {burikoRegistryFold} from '../../../src/engines/buriko/native/registry-case.js';
import {IndexedDbStore} from '../../../src/platform/store.js';
import type {BurikoSavedGame} from '../../player/buriko-library.js';
import type {SaveFilesAdapter} from '../../player/save-files.js';

const key = (entry: BurikoSaveEntry): string => `${entry.area}:${entry.path}`;
const place = (entry: BurikoSaveEntry): string =>
  entry.kind === 'user-data' ? 'UserData' : entry.area === 'game' ? 'Game data' : 'User data';

/** Game and user data saves of one BGI installation, kept in the browser. */
export function burikoSaveFiles(game: BurikoSavedGame | null, runtime: boolean): SaveFilesAdapter {
  const transfer = game
    ? new BurikoSaveTransfer((area) => IndexedDbStore.open([...game.namespace, area]))
    : null;
  const find = async (id: string | null): Promise<BurikoSaveEntry | undefined> =>
    id === null ? undefined : (await transfer!.list()).find((entry) => key(entry) === id);
  return {
    accept: '.gdb,.cad,.sud',
    unavailable: transfer
      ? null
      : runtime
        ? 'Choose a game installation to access its saves.'
        : 'Choose a BGI installation first.',
    emptyLabel: 'No browser saves yet',
    async list() {
      return (await transfer!.list()).map((entry) => ({
        id: key(entry),
        label: `${entry.name} · ${place(entry)}`,
      }));
    },
    async read(id) {
      const entry = await find(id);
      if (!entry) throw new Error('Select a save file.');
      return {name: entry.name, bytes: await transfer!.read(entry)};
    },
    async import(name, bytes, selected) {
      // An import named like the selected file replaces it; others find their own place.
      const chosen = await find(selected);
      const destination =
        chosen && burikoRegistryFold(chosen.name) === burikoRegistryFold(name) ? chosen : undefined;
      const entry = await transfer!.import(name, bytes, destination);
      const area = entry.kind === 'user-data' ? 'UserData' : entry.area;
      return {id: key(entry), message: `${entry.name} imported into browser ${area} data.`};
    },
  };
}

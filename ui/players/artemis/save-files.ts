import type {SaveFilesAdapter} from '../../player/save-files.js';
import {
  listArtemisSaves,
  readArtemisSave,
  writeArtemisSave,
  type ArtemisActiveGame,
} from '../../player/artemis-library.js';

/** The save files of the Artemis game open in the player. */
export function artemisSaveFiles(game: ArtemisActiveGame | null): SaveFilesAdapter {
  return {
    accept: '.dat',
    unavailable: game ? null : 'Open the game folder in the player to manage its saves.',
    emptyLabel: 'No browser saves yet',
    async list() {
      return (await listArtemisSaves(game!)).map((name) => ({id: name, label: name}));
    },
    async read(id) {
      return {name: id, bytes: await readArtemisSave(game!, id)};
    },
    async import(name, bytes) {
      await writeArtemisSave(game!, name, bytes);
      return {id: name, message: `${name} imported.`};
    },
  };
}

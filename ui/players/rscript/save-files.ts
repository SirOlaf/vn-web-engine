import type {SaveFilesAdapter} from '../../player/save-files.js';
import {
  listRScriptSaves,
  readRScriptSave,
  writeRScriptSave,
  type RScriptActiveGame,
} from '../../player/rscript-library.js';

/** The system save, slots and slot thumbnails of the RScript title open in the player. */
export function rscriptSaveFiles(game: RScriptActiveGame | null): SaveFilesAdapter {
  return {
    accept: '.dat,.wcg',
    unavailable: game ? null : 'Open the game folder in the player to manage its saves.',
    emptyLabel: 'No browser saves yet',
    async list() {
      return (await listRScriptSaves(game!)).map((name) => ({id: name, label: name}));
    },
    async read(id) {
      return {name: id, bytes: await readRScriptSave(game!, id)};
    },
    async import(name, bytes) {
      await writeRScriptSave(game!, name, bytes);
      return {id: name.toUpperCase(), message: `${name} imported.`};
    },
  };
}

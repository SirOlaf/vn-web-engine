import {noahSaveFiles, readNoahSave, writeNoahSave} from '../../library.js';
import type {SaveFilesAdapter} from '../../player/save-files.js';

/** CHAOS;HEAD NOAH's fixed save files in the browser's user data. */
export function noahSaveFileAdapter(): SaveFilesAdapter {
  const file = (id: string | null) => {
    const found = noahSaveFiles.find((entry) => entry.id === id);
    if (!found) throw new Error('Select a save file.');
    return found;
  };
  return {
    accept: '.dat',
    unavailable: null,
    emptyLabel: null,
    async list() {
      return noahSaveFiles.map(({id, name}) => ({id, label: name}));
    },
    async read(id) {
      return {name: file(id).name, bytes: await readNoahSave(id)};
    },
    // An import replaces the selected file, whatever its name.
    async import(_name, bytes, selected) {
      const target = file(selected);
      await writeNoahSave(target.id, bytes);
      return {id: target.id, message: `${target.name} imported.`};
    },
  };
}

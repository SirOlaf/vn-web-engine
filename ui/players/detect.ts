import {BlobSource} from '../../src/core/source.js';
import {detectInstallation} from '../../src/platform/installation-detection.js';
import {BrowserInstallationDirectoryStore} from '../../src/platform/installation-directory-store.js';
import type {InstallationSelection} from '../../src/platform/installation-picker.js';
import {PLAYERS, type PlayerEntry} from './registry.js';

const MODE_KEY = 'vn-web-engine.player-selection';

/** `auto` opens a chosen folder in the player of its engine; `manual` keeps the open player. */
export type PlayerSelectionMode = 'auto' | 'manual';

export function playerSelectionMode(): PlayerSelectionMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'manual' ? 'manual' : 'auto';
  } catch {
    return 'auto';
  }
}

export function setPlayerSelectionMode(mode: PlayerSelectionMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // The mode then lasts for this page only.
  }
}

/** The players whose engine markers the selected folder carries. */
export function detectPlayers(selection: InstallationSelection): Promise<PlayerEntry[]> {
  const files = selection.files.map(({path, file}) => ({path, source: new BlobSource(file)}));
  return detectInstallation(files, PLAYERS).then((ids) =>
    PLAYERS.filter((entry) => ids.includes(entry.id)),
  );
}

/**
 * Opens the selection in another player: its folder becomes that player's remembered folder,
 * which the player reopens on load. Selections without a folder handle cannot be passed on.
 */
export async function openInPlayer(
  entry: PlayerEntry,
  selection: InstallationSelection,
): Promise<boolean> {
  const directories = new BrowserInstallationDirectoryStore();
  if (!selection.directoryHandle || !directories.available()) return false;
  await directories.set(entry.installationKey, selection.directoryHandle);
  window.location.assign(new URL(entry.route, window.location.href));
  return true;
}

/** Why a selection could not be opened in its player automatically. */
export function detectionMessage(found: readonly PlayerEntry[], handedOff = false): string {
  if (!found.length) return 'No supported engine was recognized in this folder.';
  const names = found.map((entry) => entry.title).join(' or ');
  if (found.length > 1) return `This folder matches ${names}. Choose a player.`;
  return handedOff
    ? `Opening the ${names} player…`
    : `This folder belongs to the ${names} player. Open it and choose the folder there.`;
}

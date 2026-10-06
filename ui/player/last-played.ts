import type {PlayerId} from '../players/registry.js';

const key = (player: PlayerId): string => `vn-web-engine.last-played.${player}`;

/** Records the title a player last opened, for the library's play option. */
export function rememberLastPlayed(player: PlayerId, title: string): void {
  try {
    localStorage.setItem(key(player), title);
  } catch {
    // The library then offers to play without naming the title.
  }
}

/** The title a player last opened, or null when none is recorded. */
export function lastPlayed(player: PlayerId): string | null {
  try {
    return localStorage.getItem(key(player));
  } catch {
    return null;
  }
}

import {isInstallationMetadata} from './platform/installation-path.js';

export interface BrowserFile {
  readonly name: string;
  readonly webkitRelativePath: string;
}

export interface GameDirectory<T extends BrowserFile> {
  /** Root-folder executables, possibly none; the engine identifies which one is the game. */
  readonly executables: readonly T[];
  readonly archives: readonly T[];
}

/** Pick the files the engine understands from a browser directory selection. */
export function gameDirectoryFiles<T extends BrowserFile>(files: Iterable<T>): GameDirectory<T> {
  const executables: T[] = [];
  const archives: T[] = [];
  let root: string | undefined;

  for (const file of files) {
    const parts = file.webkitRelativePath.split('/');
    if (parts.length < 2 || parts.some((part) => !part)) continue;
    root ??= parts[0];
    if (parts[0] !== root) throw new Error('Choose a single game folder.');
    if (isInstallationMetadata(parts.slice(1).join('/'))) continue;

    if (parts.length === 2 && /\.exe$/i.test(parts[1]!)) executables.push(file);
    else if (parts.length === 3 && parts[1]!.toLowerCase() === 'data' && /\.cpk$/i.test(parts[2]!))
      archives.push(file);
  }

  if (!archives.length) throw new Error('Choose the game folder containing Data/*.cpk.');
  archives.sort((a, b) => a.name.localeCompare(b.name));
  return {executables, archives};
}

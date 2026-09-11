export interface BrowserFile {
  readonly name: string;
  readonly webkitRelativePath: string;
}

export interface GameDirectory<T extends BrowserFile> {
  readonly executable: T;
  readonly archives: readonly T[];
}

/** Pick the files the engine understands from a browser directory selection. */
export function gameDirectoryFiles<T extends BrowserFile>(files: Iterable<T>): GameDirectory<T> {
  let executable: T | undefined;
  const archives: T[] = [];
  let root: string | undefined;

  for (const file of files) {
    const parts = file.webkitRelativePath.split('/');
    if (parts.length < 2 || parts.some((part) => !part)) continue;
    root ??= parts[0];
    if (parts[0] !== root) throw new Error('Choose a single game folder.');

    if (parts.length === 2 && parts[1]!.toLowerCase() === 'game.exe') executable = file;
    else if (parts.length === 3 && parts[1]!.toLowerCase() === 'data' && /\.cpk$/i.test(parts[2]!))
      archives.push(file);
  }

  if (!executable || !archives.length)
    throw new Error('Choose the game folder containing Game.exe and Data/*.cpk.');
  archives.sort((a, b) => a.name.localeCompare(b.name));
  return {executable, archives};
}

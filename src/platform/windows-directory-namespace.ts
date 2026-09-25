import type {FileInfo, FileSystem} from './filesystem.js';

export interface WindowsDirectoryNamespaceEntry extends FileInfo {
  readonly name: string;
  readonly shortName: string | null;
}

/** Project-level fallback for FindFirstFile-style name enumeration. */
export interface WindowsDirectoryNamespaceHost {
  fold(name: string): string;
  list(files: FileSystem, directory: string): Promise<WindowsDirectoryNamespaceEntry[]>;
}

/** Browser-backed mounts expose their own listing order and spelling. The web
 * filesystem has no Windows 8.3 aliases, so those remain absent. */
export class BrowserWindowsDirectoryNamespaceHost implements WindowsDirectoryNamespaceHost {
  fold(name: string): string {
    return name.toUpperCase();
  }

  async list(files: FileSystem, directory: string): Promise<WindowsDirectoryNamespaceEntry[]> {
    return (await files.list(directory)).map((entry) => ({
      ...entry,
      name: entry.path.slice(entry.path.lastIndexOf('/') + 1),
      shortName: null,
    }));
  }
}

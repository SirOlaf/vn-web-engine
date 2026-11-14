import {filePath} from './filesystem.js';

/** Folder identities resolve into the host's virtual filesystem, never the machine's folders. */
export interface WindowsFolderPathHost {
  folderPath(csidl: number): string | null;
}

/** Explicit virtual mounts for Windows special folders. A missing mount is a failed query. */
export class VirtualWindowsFolderPaths implements WindowsFolderPathHost {
  constructor(private readonly folders: ReadonlyMap<number, string>) {}
  folderPath(csidl: number): string | null {
    return this.folders.get(csidl) ?? null;
  }
}

/** Browser save storage supplies an opaque roaming-application-data directory (CSIDL 26). */
export class BrowserWindowsFolderPaths extends VirtualWindowsFolderPaths {
  constructor() {
    super(new Map([[26, '__windows_folders__/26']]));
  }
}

/** Join a relative directory onto an explicitly mounted virtual root, preserving spelling. */
export function joinVirtualWindowsDirectory(root: string, relative: string): string {
  const normalized = relative.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.includes(':'))
    throw new Error('Windows directory requires an explicit virtual mount');
  const parts = root ? root.replaceAll('\\', '/').split('/') : [];
  const minimum = parts.length;
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === minimum) throw new Error('Windows directory escapes its virtual mount');
      parts.pop();
    } else parts.push(part);
  }
  return filePath('/' + parts.join('/')).slice(1);
}

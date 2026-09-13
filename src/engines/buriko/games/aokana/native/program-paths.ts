import {FileError, filePath} from '../../../../../platform/filesystem.js';
import {aokanaRegistryFold} from './registry-case.js';

export interface AokanaProgramPathMount {
  /** An absolute DOS directory or UNC share/directory in the declared title environment. */
  readonly native: string;
  readonly mounted: string;
}

function absolute(path: string): {root: string; parts: string[]} {
  const drive = /^([a-z]):\\/i.exec(path);
  if (drive) return {root: `${drive[1]!.toUpperCase()}:`, parts: path.slice(3).split('\\')};
  const unc = /^\\\\([^\\]+)\\([^\\]+)(?:\\|$)/.exec(path);
  if (unc) return {root: `\\\\${unc[1]}\\${unc[2]}`, parts: path.slice(unc[0].length).split('\\')};
  throw new FileError('INVALID_PATH', path);
}

function normalized(path: string): string {
  const parsed = absolute(path.replaceAll('/', '\\'));
  const parts: string[] = [];
  for (const part of parsed.parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else {
      if (/[:\0]/.test(part)) throw new FileError('INVALID_PATH', path);
      parts.push(part);
    }
  }
  return parsed.root + '\\' + parts.join('\\');
}

/** Explicit mounted DOS/UNC profile for CFileDX's OS path boundary.
 * Only declared mounts are reachable. Prefix comparison uses the declared Unicode 15.1 BMP
 * uppercase profile; suffix spelling remains available to the mounted filesystem's own policy. */
export class AokanaMountedProgramPaths {
  private readonly mounts: {native: string; folded: string; mounted: string}[];
  private readonly driveDirectories = new Map<string, string>();
  private directory: string;

  constructor(mounts: readonly AokanaProgramPathMount[], currentDirectory: string) {
    this.mounts = mounts
      .map((mount) => {
        const native = normalized(mount.native).replace(/\\$/, '');
        return {native, folded: aokanaRegistryFold(native), mounted: filePath(mount.mounted)};
      })
      .sort((a, b) => b.native.length - a.native.length);
    this.directory = normalized(currentDirectory);
    this.rememberDriveDirectory(this.directory);
  }

  get currentDirectory(): string {
    return this.directory;
  }

  private rememberDriveDirectory(path: string): void {
    if (/^[A-Z]:/.test(path)) this.driveDirectories.set(path.slice(0, 2), path);
  }

  /** Called only after the file-service owner has verified directory existence. */
  setCurrentDirectory(path: string): void {
    this.directory = this.resolveNative(path);
    this.rememberDriveDirectory(this.directory);
  }

  resolveNative(value: string): string {
    const at = value.indexOf('\0');
    let path = (at < 0 ? value : value.slice(0, at)).replaceAll('/', '\\');
    if (path === '') throw new FileError('INVALID_PATH', value);
    if (/^\\\\/.test(path) || /^[a-z]:\\/i.test(path)) return normalized(path);
    const relativeDrive = /^([a-z]):/i.exec(path);
    if (relativeDrive) {
      const drive = `${relativeDrive[1]!.toUpperCase()}:`;
      path = (this.driveDirectories.get(drive) ?? `${drive}\\`) + '\\' + path.slice(2);
    } else if (path.startsWith('\\')) {
      path = absolute(this.directory).root + path;
    } else path = this.directory + '\\' + path;
    return normalized(path);
  }

  resolve(value: string): string {
    const path = this.resolveNative(value),
      folded = aokanaRegistryFold(path);
    for (const mount of this.mounts) {
      if (folded !== mount.folded && !folded.startsWith(mount.folded + '\\')) continue;
      const suffix = path.slice(mount.native.length).replace(/^\\/, '').replaceAll('\\', '/');
      return filePath(mount.mounted + (suffix ? (mount.mounted === '/' ? '' : '/') + suffix : ''));
    }
    throw new FileError('NOT_FOUND', value);
  }
}

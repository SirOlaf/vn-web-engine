import {filePath, FileError} from './filesystem.js';
import type {FileSystem, FileInfo, FileChange} from './filesystem.js';
import type {ByteSource} from '../core/source.js';

/** Audited ASCII subset. No guessed Unicode/locale-dependent Windows case mappings. */
export function windowsFileKey(path: string): string {
  filePath(path);
  if (/[^\x00-\x7f]/.test(path))
    throw new Error('Windows Unicode filename requires an audited casing policy');
  return path.replace(/[a-z]/g, (c) => c.toUpperCase());
}
export interface WindowsMount {
  windows: string;
  virtual: string;
}
export interface WindowsPathOptions {
  mounts: readonly WindowsMount[];
  cwd: string;
  /** Explicit per-drive current directories for C:relative paths. No host environment lookup. */
  driveDirectories?: Readonly<Record<string, string>>;
}
interface Absolute {
  root: string;
  parts: string[];
}
function render(p: Absolute): string {
  return p.root + '\\' + p.parts.join('\\');
}
function fold(s: string): string {
  if (/[^\x00-\x7f]/.test(s))
    throw new Error('Windows Unicode filename requires an audited casing policy');
  return s.replace(/[a-z]/g, (c) => c.toUpperCase());
}
function components(base: Absolute, path: string): Absolute {
  const parts = [...base.parts];
  for (const raw of path.split('\\')) {
    if (!raw || raw === '.') continue;
    if (raw === '..') {
      parts.pop();
      continue;
    }
    const part = raw.replace(/[ .]+$/g, '');
    if (!part || /[\x00-\x1f<>:"|?*]/.test(part)) throw new FileError('INVALID_PATH', path);
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))
      throw new Error(`Windows device path is unsupported: ${part}`);
    parts.push(fold(part));
  }
  return {root: base.root, parts};
}
function absolute(path: string): Absolute {
  path = path.replace(/\//g, '\\');
  if (path.startsWith('\\\\?\\') || path.startsWith('\\\\.\\'))
    throw new Error('Windows extended/device namespace is unsupported');
  const drive = /^([a-z]):\\(.*)$/i.exec(path);
  if (drive) return components({root: drive[1]!.toUpperCase() + ':', parts: []}, drive[2]!);
  const unc = /^\\\\([^\\]+)\\([^\\]+)(?:\\(.*))?$/.exec(path);
  if (unc) {
    for (const p of [unc[1]!, unc[2]!])
      if (/[\x00-\x1f<>:"|?*]/.test(p) || p === '.' || p === '..' || /[ .]$/.test(p))
        throw new FileError('INVALID_PATH', path);
    return components(
      {root: '\\\\' + fold(unc[1]!) + '\\' + fold(unc[2]!), parts: []},
      unc[3] ?? '',
    );
  }
  throw new FileError('INVALID_PATH', path);
}
/** Windows spelling -> explicitly mounted virtual paths. Never accesses host drives. */
export class WindowsFileSystem implements FileSystem {
  private cwd: Absolute;
  private drives = new Map<string, Absolute>();
  private mounts: {native: Absolute; virtual: string}[];
  constructor(
    private readonly files: FileSystem,
    options: WindowsPathOptions,
  ) {
    this.cwd = absolute(options.cwd);
    for (const [drive, path] of Object.entries(options.driveDirectories ?? {})) {
      if (!/^[a-z]:$/i.test(drive)) throw new FileError('INVALID_PATH', drive);
      const p = absolute(path);
      if (p.root !== drive.toUpperCase()) throw new FileError('INVALID_PATH', path);
      this.drives.set(p.root, p);
    }
    if (/^[A-Z]:$/.test(this.cwd.root)) this.drives.set(this.cwd.root, this.cwd);
    this.mounts = options.mounts
      .map((m) => ({native: absolute(m.windows), virtual: filePath(m.virtual)}))
      .sort((a, b) => b.native.parts.length - a.native.parts.length);
    const keys = this.mounts.map((m) => render(m.native));
    if (new Set(keys).size !== keys.length) throw new Error('Duplicate Windows mount');
    this.resolve(options.cwd); // Current directory must at least map into the virtual filesystem.
  }
  private normalize(path: string): Absolute {
    if (!path || path.includes('\0')) throw new FileError('INVALID_PATH', path);
    path = path.replace(/\//g, '\\');
    if (/^[a-z]:\\/i.test(path) || path.startsWith('\\\\')) return absolute(path);
    const drive = /^([a-z]):(.*)$/i.exec(path);
    if (drive) {
      const base = this.drives.get(drive[1]!.toUpperCase() + ':');
      if (!base) throw new Error(`No virtual current directory for drive ${drive[1]}:`);
      return components(base, drive[2]!);
    }
    if (path.startsWith('\\')) return components({root: this.cwd.root, parts: []}, path.slice(1));
    return components(this.cwd, path);
  }
  resolve(path: string): {windows: string; virtual: string} {
    const p = this.normalize(path);
    const mount = this.mounts.find(
      (m) => m.native.root === p.root && m.native.parts.every((s, i) => s === p.parts[i]),
    );
    if (!mount) throw new FileError('NOT_FOUND', `Unmapped Windows path ${render(p)}`);
    const tail = p.parts.slice(mount.native.parts.length).join('/');
    return {
      windows: render(p),
      virtual: filePath(
        (mount.virtual === '/' ? '' : mount.virtual) + (tail ? '/' + tail : '') || '/',
      ),
    };
  }
  async chdir(path: string): Promise<void> {
    const resolved = this.resolve(path);
    if ((await this.files.stat(resolved.virtual)).kind !== 'directory')
      throw new FileError('NOT_DIRECTORY', path);
    this.cwd = absolute(resolved.windows);
    if (/^[A-Z]:$/.test(this.cwd.root)) this.drives.set(this.cwd.root, this.cwd);
  }
  async stat(path: string): Promise<FileInfo> {
    const r = this.resolve(path);
    return {...(await this.files.stat(r.virtual)), path: r.windows};
  }
  async list(path: string): Promise<FileInfo[]> {
    const r = this.resolve(path),
      children = await this.files.list(r.virtual);
    return children.map((i) => ({
      ...i,
      path: r.windows.replace(/\\$/, '') + '\\' + i.path.split('/').at(-1)!,
    }));
  }
  async open(path: string): Promise<ByteSource> {
    return this.files.open(this.resolve(path).virtual);
  }
  async commit(changes: readonly FileChange[]): Promise<void> {
    await this.files.commit(changes.map((c) => ({...c, path: this.resolve(c.path).virtual})));
  }
}

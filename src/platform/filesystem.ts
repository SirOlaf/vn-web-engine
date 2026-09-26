import {BlobSource} from '../core/source.js';
import type {ByteSource} from '../core/source.js';
import type {RecordStore} from './store.js';

export type FileErrorCode =
  'NOT_FOUND' | 'IS_DIRECTORY' | 'NOT_DIRECTORY' | 'READ_ONLY' | 'INVALID_PATH' | 'CROSS_MOUNT';
export class FileError extends Error {
  constructor(
    readonly code: FileErrorCode,
    readonly path: string,
  ) {
    super(`${code}: ${path}`);
    this.name = 'FileError';
  }
}
export interface FileInfo {
  path: string;
  kind: 'file' | 'directory';
  size: number;
}
export type FileChange =
  {kind: 'write'; path: string; data: Uint8Array} | {kind: 'delete'; path: string};
export interface FileSystem {
  stat(path: string): Promise<FileInfo>;
  list(path: string): Promise<FileInfo[]>;
  open(path: string): Promise<ByteSource>;
  /** All changes commit together, in listed order. Writes can supply implicit directories. */
  commit(changes: readonly FileChange[]): Promise<void>;
}
export function filePath(path: string): string {
  if (path === '/') return path;
  if (
    !path.startsWith('/') ||
    /[\\:\0]/.test(path) ||
    path
      .split('/')
      .slice(1)
      .some((s) => !s || s === '.' || s === '..')
  )
    throw new FileError('INVALID_PATH', path);
  return path;
}
const noDirectories: ReadonlySet<string> = new Set();
function info(
  files: ReadonlyMap<string, {size: number}>,
  path: string,
  directories: ReadonlySet<string> = noDirectories,
): FileInfo {
  filePath(path);
  const file = files.get(path);
  if (file) return {path, kind: 'file', size: file.size};
  if (
    path === '/' ||
    directories.has(path) ||
    [...files.keys(), ...directories].some((p) => p.startsWith(path + '/'))
  )
    return {path, kind: 'directory', size: 0};
  throw new FileError('NOT_FOUND', path);
}
function listing(
  files: ReadonlyMap<string, {size: number}>,
  path: string,
  directories: ReadonlySet<string> = noDirectories,
): FileInfo[] {
  if (info(files, path, directories).kind !== 'directory')
    throw new FileError('NOT_DIRECTORY', path);
  const prefix = path === '/' ? '/' : path + '/',
    children = new Set<string>();
  for (const key of [...files.keys(), ...directories])
    if (key.startsWith(prefix)) children.add(prefix + key.slice(prefix.length).split('/')[0]!);
  return Array.from(children)
    .sort()
    .map((p) => info(files, p, directories));
}
function noParents(files: ReadonlyMap<string, unknown>, path: string): void {
  for (let i = path.indexOf('/', 1); i !== -1; i = path.indexOf('/', i + 1))
    if (files.has(path.slice(0, i))) throw new FileError('NOT_DIRECTORY', path.slice(0, i));
}
/** Range sources stay intact, including their worker-transferable HTTP/Blob identity. */
export class SourceFileSystem implements FileSystem {
  private files = new Map<string, ByteSource>();
  private directories = new Set<string>();
  constructor(private readonly canonical: (path: string) => string = filePath) {}
  attach(path: string, source: ByteSource): void {
    path = filePath(this.canonical(filePath(path)));
    noParents(this.files, path);
    if (
      path === '/' ||
      this.directories.has(path) ||
      [...this.files.keys(), ...this.directories].some((p) => p.startsWith(path + '/'))
    )
      throw new FileError('IS_DIRECTORY', path);
    this.files.set(path, source);
  }
  /** File sources retain their range-readable identity in the returned snapshot. */
  entries(): ReadonlyMap<string, ByteSource> {
    return new Map(this.files);
  }
  /** Preserve directory handles with no files, without fabricating a marker file. */
  attachDirectory(path: string): void {
    path = filePath(this.canonical(filePath(path)));
    noParents(this.files, path);
    if (this.files.has(path)) throw new FileError('NOT_DIRECTORY', path);
    if (path !== '/') this.directories.add(path);
  }
  directoryEntries(): ReadonlySet<string> {
    return new Set(this.directories);
  }
  /** Replace an installation without leaving files from the previous selection mounted. */
  clear(): void {
    this.files.clear();
    this.directories.clear();
  }
  async stat(path: string): Promise<FileInfo> {
    return info(this.files, this.canonical(filePath(path)), this.directories);
  }
  async list(path: string): Promise<FileInfo[]> {
    return listing(this.files, this.canonical(filePath(path)), this.directories);
  }
  async open(path: string): Promise<ByteSource> {
    path = this.canonical(filePath(path));
    if ((await this.stat(path)).kind === 'directory') throw new FileError('IS_DIRECTORY', path);
    return this.files.get(path)!;
  }
  async commit(changes: readonly FileChange[]): Promise<void> {
    if (changes.length) throw new FileError('READ_ONLY', changes[0]!.path);
  }
}
/** Persistent writes over an installed, range-readable file tree. */
export class OverlayFileSystem implements FileSystem {
  constructor(
    private readonly installed: SourceFileSystem,
    private readonly store: RecordStore,
    private readonly canonical: (path: string) => string = filePath,
  ) {}
  private path(path: string): string {
    return filePath(this.canonical(filePath(path)));
  }
  private directories(records: ReadonlyMap<string, Uint8Array>): ReadonlySet<string> {
    const directories = new Set(
      [...this.installed.directoryEntries()].map((path) => this.path(path)),
    );
    for (const key of records.keys())
      if (key.startsWith('directory:')) directories.add(key.slice('directory:'.length));
    return directories;
  }
  /** Install a verified virtual directory layout in browser storage, without device writes. */
  async installDirectories(paths: readonly string[]): Promise<void> {
    const captured = paths.map((path) => this.path(path)).filter((path) => path !== '/');
    if (captured.length === 0) return;
    await this.store.update((records) => {
      const files = this.visible(records);
      for (const path of captured) {
        noParents(files, path);
        if (files.has(path)) throw new FileError('NOT_DIRECTORY', path);
        records.set('directory:' + path, new Uint8Array());
      }
    });
  }
  private visible(records: ReadonlyMap<string, Uint8Array>): Map<string, {size: number}> {
    const files = new Map<string, {size: number}>();
    for (const [path, source] of this.installed.entries())
      files.set(this.path(path), {size: source.size});
    for (const key of records.keys())
      if (key.startsWith('tombstone:')) files.delete(key.slice('tombstone:'.length));
    for (const [key, data] of records)
      if (key.startsWith('file:')) files.set(key.slice('file:'.length), {size: data.length});
    return files;
  }
  async stat(path: string): Promise<FileInfo> {
    const records = await this.store.snapshot();
    return info(this.visible(records), this.path(path), this.directories(records));
  }
  async list(path: string): Promise<FileInfo[]> {
    const records = await this.store.snapshot();
    return listing(this.visible(records), this.path(path), this.directories(records));
  }
  async open(path: string): Promise<ByteSource> {
    path = this.path(path);
    const records = await this.store.snapshot();
    if (info(this.visible(records), path, this.directories(records)).kind === 'directory')
      throw new FileError('IS_DIRECTORY', path);
    const data = records.get('file:' + path);
    if (data) return new BlobSource(new Blob([data.slice().buffer]));
    return this.installed.open(path);
  }
  async commit(changes: readonly FileChange[]): Promise<void> {
    const captured = changes.map((change) => {
      const path = this.path(change.path);
      return change.kind === 'write'
        ? {...change, path, data: change.data.slice()}
        : {...change, path};
    });
    if (!captured.length) return;
    const installed = this.installed.entries();
    await this.store.update((records) => {
      const files = this.visible(records);
      const directories = this.directories(records);
      for (const change of captured) {
        const path = change.path;
        noParents(files, path);
        if (
          path === '/' ||
          directories.has(path) ||
          [...files.keys(), ...directories].some((p) => p.startsWith(path + '/'))
        )
          throw new FileError('IS_DIRECTORY', path);
        if (change.kind === 'write') {
          records.set('file:' + path, change.data);
          records.delete('tombstone:' + path);
          files.set(path, {size: change.data.length});
        } else {
          if (!files.has(path)) throw new FileError('NOT_FOUND', path);
          records.delete('file:' + path);
          if (installed.has(path)) records.set('tombstone:' + path, new Uint8Array());
          else records.delete('tombstone:' + path);
          files.delete(path);
        }
      }
    });
  }
}
export class StoredFileSystem implements FileSystem {
  constructor(
    private readonly store: RecordStore,
    private readonly canonical: (path: string) => string = filePath,
  ) {}
  private files(records: ReadonlyMap<string, Uint8Array>): Map<string, BlobSource> {
    return new Map(
      Array.from(records)
        .filter(([k]) => k.startsWith('file:'))
        .map(([k, v]) => [k.slice(5), new BlobSource(new Blob([v.slice().buffer]))]),
    );
  }
  async stat(path: string): Promise<FileInfo> {
    return info(this.files(await this.store.snapshot()), this.canonical(filePath(path)));
  }
  async list(path: string): Promise<FileInfo[]> {
    return listing(this.files(await this.store.snapshot()), this.canonical(filePath(path)));
  }
  async open(path: string): Promise<ByteSource> {
    path = this.canonical(filePath(path));
    const files = this.files(await this.store.snapshot());
    if (info(files, path).kind === 'directory') throw new FileError('IS_DIRECTORY', path);
    return files.get(path)!; // Immutable snapshot; later writes do not change an open source.
  }
  async commit(changes: readonly FileChange[]): Promise<void> {
    const captured = changes.map((c) => {
      const path = filePath(this.canonical(filePath(c.path)));
      return c.kind === 'write' ? {...c, path, data: c.data.slice()} : {...c, path};
    });
    if (!captured.length) return;
    await this.store.update((records) => {
      const files = new Map(
        Array.from(records)
          .filter(([k]) => k.startsWith('file:'))
          .map(([k, v]) => [k.slice(5), {size: v.length}]),
      );
      for (const change of captured) {
        const path = change.path;
        noParents(files, path);
        if (path === '/' || Array.from(files.keys()).some((p) => p.startsWith(path + '/')))
          throw new FileError('IS_DIRECTORY', path);
        if (change.kind === 'write') {
          records.set('file:' + path, change.data);
          files.set(path, {size: change.data.length});
        } else {
          if (!files.has(path)) throw new FileError('NOT_FOUND', path);
          records.delete('file:' + path);
          files.delete(path);
        }
      }
    });
  }
}
/** Disjoint top-level mounts. Cross-mount atomic updates are explicitly rejected. */
export class MountedFileSystem implements FileSystem {
  private mounts = new Map<string, FileSystem>();
  mount(path: string, fs: FileSystem): void {
    filePath(path);
    if (path === '/' || path.indexOf('/', 1) !== -1 || this.mounts.has(path))
      throw new FileError('INVALID_PATH', path);
    this.mounts.set(path, fs);
  }
  private resolve(path: string): {root: string; path: string; fs: FileSystem} {
    filePath(path);
    const end = path.indexOf('/', 1),
      root = end < 0 ? path : path.slice(0, end),
      fs = this.mounts.get(root);
    if (!fs) throw new FileError('NOT_FOUND', path);
    return {root, path: end < 0 ? '/' : path.slice(end), fs};
  }
  async stat(path: string): Promise<FileInfo> {
    if (path === '/') return {path, kind: 'directory', size: 0};
    const r = this.resolve(path);
    return {...(await r.fs.stat(r.path)), path};
  }
  async list(path: string): Promise<FileInfo[]> {
    if (path === '/')
      return Array.from(this.mounts.keys())
        .sort()
        .map((path) => ({path, kind: 'directory', size: 0}));
    const r = this.resolve(path);
    return (await r.fs.list(r.path)).map((i) => ({...i, path: r.root + i.path}));
  }
  open(path: string): Promise<ByteSource> {
    if (path === '/') return Promise.reject(new FileError('IS_DIRECTORY', path));
    try {
      const r = this.resolve(path);
      return r.fs.open(r.path);
    } catch (error) {
      return Promise.reject(error);
    }
  }
  async commit(changes: readonly FileChange[]): Promise<void> {
    if (!changes.length) return;
    const resolved = changes.map((c) => ({change: c, ...this.resolve(c.path)})),
      first = resolved[0]!;
    if (resolved.some((r) => r.root !== first.root))
      throw new FileError('CROSS_MOUNT', changes[0]!.path);
    await first.fs.commit(resolved.map((r) => ({...r.change, path: r.path})));
  }
}
export async function readFile(
  fs: FileSystem,
  path: string,
  limit = 64 * 1024 * 1024,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid file read limit');
  const source = await fs.open(path);
  if (source.size > limit) throw new Error(`File exceeds read limit: ${path}`);
  return source.read(0, source.size);
}

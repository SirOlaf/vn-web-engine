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
  /** All changes commit together, in listed order. Directories are implicit. */
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
function info(files: ReadonlyMap<string, {size: number}>, path: string): FileInfo {
  filePath(path);
  const file = files.get(path);
  if (file) return {path, kind: 'file', size: file.size};
  if (path === '/' || Array.from(files.keys()).some((p) => p.startsWith(path + '/')))
    return {path, kind: 'directory', size: 0};
  throw new FileError('NOT_FOUND', path);
}
function listing(files: ReadonlyMap<string, {size: number}>, path: string): FileInfo[] {
  if (info(files, path).kind !== 'directory') throw new FileError('NOT_DIRECTORY', path);
  const prefix = path === '/' ? '/' : path + '/',
    children = new Set<string>();
  for (const key of files.keys())
    if (key.startsWith(prefix)) children.add(prefix + key.slice(prefix.length).split('/')[0]!);
  return Array.from(children)
    .sort()
    .map((p) => info(files, p));
}
function noParents(files: ReadonlyMap<string, unknown>, path: string): void {
  for (let i = path.indexOf('/', 1); i !== -1; i = path.indexOf('/', i + 1))
    if (files.has(path.slice(0, i))) throw new FileError('NOT_DIRECTORY', path.slice(0, i));
}
/** Range sources stay intact, including their worker-transferable HTTP/Blob identity. */
export class SourceFileSystem implements FileSystem {
  private files = new Map<string, ByteSource>();
  constructor(private readonly canonical: (path: string) => string = filePath) {}
  attach(path: string, source: ByteSource): void {
    path = filePath(this.canonical(filePath(path)));
    noParents(this.files, path);
    if (path === '/' || Array.from(this.files.keys()).some((p) => p.startsWith(path + '/')))
      throw new FileError('IS_DIRECTORY', path);
    this.files.set(path, source);
  }
  async stat(path: string): Promise<FileInfo> {
    return info(this.files, this.canonical(filePath(path)));
  }
  async list(path: string): Promise<FileInfo[]> {
    return listing(this.files, this.canonical(filePath(path)));
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

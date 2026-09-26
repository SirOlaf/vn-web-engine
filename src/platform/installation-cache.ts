import {BlobSource} from '../core/source.js';
import type {ByteSource} from '../core/source.js';
import {filePath} from './filesystem.js';

export interface InstallationFile {
  path: string;
  source: ByteSource;
  lastModifiedMs: number;
}
export interface CachedInstallation {
  files: InstallationFile[];
  /** Paths of directories below the installation root, including empty directories. */
  readonly directories?: readonly string[];
  metadata: Record<string, string>;
  attachments: Record<string, Blob>;
}
export interface InstallationCacheProgress {
  path: string;
  completedBytes: number;
  totalBytes: number;
}
export interface InstallationCacheSaveOptions {
  signal?: AbortSignal;
  progress?: (progress: InstallationCacheProgress) => void;
}

const rootName = 'vn-web-engine-installations',
  chunkSize = 4 * 1024 * 1024,
  manifestLimit = 4 * 1024 * 1024;
interface FileEntry {
  path: string;
  id: string;
  size: number;
  lastModifiedMs: number;
}
interface AttachmentEntry {
  name: string;
  id: string;
  size: number;
  type: string;
}
interface Manifest {
  version: 1;
  key: string;
  files: FileEntry[];
  directories?: string[];
  metadata: Record<string, string>;
  attachments: AttachmentEntry[];
}
const pending = new WeakMap<StorageManager, Map<string, Promise<unknown>>>();
let generationSequence = 0;

function missing(error: unknown): boolean {
  return error instanceof Error && error.name === 'NotFoundError';
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function byteSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function stringRecord(value: unknown): value is Record<string, string> {
  return record(value) && Object.values(value).every((entry) => typeof entry === 'string');
}
function cacheName(key: string): string {
  if (!key) throw new Error('An installation cache key is required');
  return `installation-${encodeURIComponent(key)}`;
}
function abort(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Cancelled', 'AbortError');
}
async function readJson(handle: FileSystemFileHandle, limit: number): Promise<unknown> {
  const file = await handle.getFile();
  if (file.size > limit) throw new Error('Browser installation cache manifest is too large');
  return JSON.parse(await file.text());
}
async function writeJson(
  directory: FileSystemDirectoryHandle,
  name: string,
  text: string,
  signal?: AbortSignal,
): Promise<void> {
  const handle = await directory.getFileHandle(name, {create: true}),
    writer = await handle.createWritable();
  try {
    abort(signal);
    await writer.write(text);
    abort(signal);
    // createWritable publishes its temporary file on close, including the current pointer.
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => {});
    throw error;
  }
}
async function pointer(directory: FileSystemDirectoryHandle): Promise<string | null> {
  let handle: FileSystemFileHandle;
  try {
    handle = await directory.getFileHandle('current.json');
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  // A cancelled first write may have created the entry without publishing a pointer.
  if ((await handle.getFile()).size === 0) return null;
  const value = await readJson(handle, 1024);
  if (
    !record(value) ||
    value.version !== 1 ||
    typeof value.generation !== 'string' ||
    !/^generation-[a-z0-9-]+$/.test(value.generation)
  )
    throw new Error('Invalid browser installation cache pointer');
  return value.generation;
}
function manifest(value: unknown, key: string): Manifest {
  if (
    !record(value) ||
    value.version !== 1 ||
    value.key !== key ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.attachments) ||
    !stringRecord(value.metadata)
  )
    throw new Error('Invalid browser installation cache manifest');
  const paths = new Set<string>(),
    directories = new Set<string>(),
    names = new Set<string>();
  for (const [index, file] of value.files.entries()) {
    if (
      !record(file) ||
      typeof file.path !== 'string' ||
      !file.path ||
      paths.has(file.path) ||
      file.id !== `file-${index}` ||
      !byteSize(file.size) ||
      typeof file.lastModifiedMs !== 'number' ||
      !Number.isFinite(file.lastModifiedMs)
    )
      throw new Error('Invalid browser installation cache file');
    paths.add(file.path);
  }
  if (value.directories !== undefined) {
    if (!Array.isArray(value.directories))
      throw new Error('Invalid browser installation cache directory list');
    for (const directory of value.directories) {
      let path: string;
      try {
        if (typeof directory !== 'string' || !directory.startsWith('/'))
          throw new Error('not absolute');
        path = filePath(directory);
      } catch {
        throw new Error('Invalid browser installation cache directory');
      }
      if (path === '/' || directories.has(path))
        throw new Error('Invalid browser installation cache directory');
      // A file cannot also be a directory or contain a child directory.
      if ([...paths].some((file) => file === path || path.startsWith(file + '/')))
        throw new Error('Conflicting browser installation cache paths');
      directories.add(path);
    }
  }
  for (const [index, attachment] of value.attachments.entries()) {
    if (
      !record(attachment) ||
      typeof attachment.name !== 'string' ||
      names.has(attachment.name) ||
      attachment.id !== `attachment-${index}` ||
      !byteSize(attachment.size) ||
      typeof attachment.type !== 'string'
    )
      throw new Error('Invalid browser installation cache attachment');
    names.add(attachment.name);
  }
  return value as unknown as Manifest;
}

/** Installation bytes only: virtual saves, registry and user state live in separate stores.
 * Returned Files are disk snapshots; do not replace/remove an installation still in use.
 */
export class BrowserInstallationCache {
  private readonly storage: StorageManager | undefined;
  private readonly injected: boolean;
  constructor(storage?: StorageManager) {
    this.injected = storage !== undefined;
    this.storage = storage ?? globalThis.navigator?.storage;
  }

  available(): boolean {
    return (
      typeof this.storage?.getDirectory === 'function' &&
      (this.injected ||
        (typeof FileSystemFileHandle !== 'undefined' &&
          typeof FileSystemFileHandle.prototype.createWritable === 'function'))
    );
  }

  private async locked<T>(key: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!this.available()) throw new Error('Browser installation storage is unavailable');
    const name = cacheName(key),
      locks = globalThis.navigator?.locks;
    if (locks) return locks.request(`${rootName}:${name}`, {signal}, work);
    // Older browsers still serialize operations across instances in this page. Without
    // Web Locks we never sweep unknown generations, which another page could be writing.
    const storage = this.storage!,
      queue = pending.get(storage) ?? new Map<string, Promise<unknown>>();
    pending.set(storage, queue);
    const result = (queue.get(name) ?? Promise.resolve()).catch(() => {}).then(work);
    queue.set(name, result);
    try {
      return await result;
    } finally {
      if (queue.get(name) === result) queue.delete(name);
    }
  }

  private async root(create: boolean): Promise<FileSystemDirectoryHandle | null> {
    try {
      return await (await this.storage!.getDirectory()).getDirectoryHandle(rootName, {create});
    } catch (error) {
      if (!create && missing(error)) return null;
      throw error;
    }
  }

  private async directory(key: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
    const root = await this.root(create);
    if (!root) return null;
    try {
      return await root.getDirectoryHandle(cacheName(key), {create});
    } catch (error) {
      if (!create && missing(error)) return null;
      throw error;
    }
  }

  open(key: string): Promise<CachedInstallation | null> {
    return this.locked(key, async () => {
      const directory = await this.directory(key, false);
      if (!directory) return null;
      const generation = await pointer(directory);
      if (!generation) return null;
      const data = await directory.getDirectoryHandle(generation),
        info = manifest(
          await readJson(await data.getFileHandle('manifest.json'), manifestLimit),
          key,
        ),
        files: InstallationFile[] = [],
        attachments: Record<string, Blob> = Object.create(null);
      const read = async (entry: {id: string; size: number}): Promise<File> => {
        const file = await (await data.getFileHandle(entry.id)).getFile();
        if (file.size !== entry.size) throw new Error('Incomplete browser installation cache file');
        return file;
      };
      for (const file of info.files)
        files.push({
          path: file.path,
          source: new BlobSource(await read(file)),
          lastModifiedMs: file.lastModifiedMs,
        });
      for (const attachment of info.attachments) {
        const file = await read(attachment);
        attachments[attachment.name] = file.slice(0, file.size, attachment.type);
      }
      return {
        files,
        ...(info.directories === undefined ? {} : {directories: [...info.directories]}),
        metadata: info.metadata,
        attachments,
      };
    });
  }

  save(
    key: string,
    installation: CachedInstallation,
    options: InstallationCacheSaveOptions = {},
  ): Promise<{persistent: boolean}> {
    return this.locked(
      key,
      async () => {
        abort(options.signal);
        const files = installation.files.map((file) => ({...file})),
          attachments = Object.entries(installation.attachments),
          info = manifest(
            {
              version: 1,
              key,
              files: files.map((file, index) => ({
                path: file.path,
                id: `file-${index}`,
                size: file.source.size,
                lastModifiedMs: file.lastModifiedMs,
              })),
              ...(installation.directories === undefined
                ? {}
                : {directories: [...installation.directories]}),
              metadata: installation.metadata,
              attachments: attachments.map(([name, blob], index) => ({
                name,
                id: `attachment-${index}`,
                size: blob.size,
                type: blob.type,
              })),
            },
            key,
          ),
          json = JSON.stringify(info),
          manifestBytes = new TextEncoder().encode(json).length,
          totalBytes = [...info.files, ...info.attachments].reduce(
            (sum, entry) => sum + entry.size,
            0,
          );
        if (manifestBytes > manifestLimit || !byteSize(totalBytes))
          throw new Error('Browser installation cache is too large');
        const directory = (await this.directory(key, true))!,
          previous = await pointer(directory);
        if (globalThis.navigator?.locks) await this.cleanup(directory, previous);
        const estimate =
          typeof this.storage!.estimate === 'function'
            ? await this.storage!.estimate().catch(() => undefined)
            : undefined;
        if (
          estimate &&
          typeof estimate.quota === 'number' &&
          Number.isFinite(estimate.quota) &&
          typeof estimate.usage === 'number' &&
          Number.isFinite(estimate.usage) &&
          estimate.quota - estimate.usage < totalBytes + manifestBytes + 1024
        )
          throw new Error('Not enough browser storage for this installation and its existing copy');
        const persistent =
            typeof this.storage!.persist === 'function'
              ? await this.storage!.persist().catch(() => false)
              : false,
          generation = `generation-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${++generationSequence}-${Math.random().toString(36).slice(2)}`}`,
          data = await directory.getDirectoryHandle(generation, {create: true});
        let committed = false,
          completedBytes = 0;
        try {
          const copy = async (id: string, path: string, source: ByteSource): Promise<void> => {
            abort(options.signal);
            options.progress?.({path, completedBytes, totalBytes});
            const writer = await (await data.getFileHandle(id, {create: true})).createWritable();
            try {
              for (let offset = 0; offset < source.size; offset += chunkSize) {
                abort(options.signal);
                const length = Math.min(chunkSize, source.size - offset),
                  bytes = await source.read(offset, length, options.signal);
                if (bytes.byteLength !== length)
                  throw new Error(`Truncated installation file: ${path}`);
                abort(options.signal);
                await writer.write(
                  bytes.buffer instanceof ArrayBuffer
                    ? (bytes as Uint8Array<ArrayBuffer>)
                    : new Uint8Array(bytes),
                );
                completedBytes += length;
                options.progress?.({path, completedBytes, totalBytes});
              }
              abort(options.signal);
              await writer.close();
            } catch (error) {
              await writer.abort().catch(() => {});
              throw error;
            }
          };
          for (const [index, file] of files.entries())
            await copy(info.files[index]!.id, file.path, file.source);
          for (const [index, [name, blob]] of attachments.entries())
            await copy(info.attachments[index]!.id, name, new BlobSource(blob));
          await writeJson(data, 'manifest.json', json, options.signal);
          await writeJson(
            directory,
            'current.json',
            JSON.stringify({version: 1, generation}),
            options.signal,
          );
          committed = true;
        } finally {
          if (!committed) await directory.removeEntry(generation, {recursive: true});
        }
        // Cleanup failures must not turn a committed installation into a reported failure.
        if (previous) await directory.removeEntry(previous, {recursive: true}).catch(() => {});
        return {persistent};
      },
      options.signal,
    );
  }

  private async cleanup(directory: FileSystemDirectoryHandle, keep: string | null): Promise<void> {
    for await (const [name, handle] of directory.entries())
      if (handle.kind === 'directory' && name.startsWith('generation-') && name !== keep)
        await directory.removeEntry(name, {recursive: true});
  }

  remove(key: string): Promise<void> {
    return this.locked(key, async () => {
      const root = await this.root(false);
      if (!root) return;
      try {
        await root.removeEntry(cacheName(key), {recursive: true});
      } catch (error) {
        if (!missing(error)) throw error;
      }
    });
  }
}

import type {ByteSource} from '../../../core/source.js';
import {
  FileError,
  MountedFileSystem,
  filePath,
  type FileChange,
  type FileInfo,
  type FileSystem,
} from '../../../platform/filesystem.js';

export interface BurikoFileTimes {
  readonly creationTime: bigint;
  readonly accessTime: bigint;
  readonly writeTime: bigint;
}
export interface BurikoFileMetadataRecord {
  readonly path: string;
  readonly kind: 'file' | 'directory';
  /** Unknown imported attributes and times remain unknown until an actual write supplies them. */
  attributes: number | null;
  creationTime: bigint | null;
  accessTime: bigint | null;
  writeTime: bigint | null;
}
export interface BurikoFileMetadataVolume {
  readonly path: string;
  readonly identity: object;
  readonly writable: boolean;
}
export interface BurikoNamespaceEntry {
  readonly path: string;
  readonly name: string;
  readonly shortName: string | null;
}
export interface BurikoNamespaceProfile {
  /** Explicit find order; new entries append. No order or spelling is inferred from backing list. */
  readonly entries: readonly BurikoNamespaceEntry[];
  readonly newShortNames: 'disabled';
  readonly fold: (name: string) => string;
}
export interface BurikoMoveProfile {
  readonly contents: 'ordinary-single-stream';
  readonly security: 'unsupported';
  readonly copiedTimes: 'preserve-source';
  readonly copyDeleteFailure: 'success-retain-source';
}
export interface BurikoFileMetadataProfile {
  readonly move?: BurikoMoveProfile;
  readonly namespace?: BurikoNamespaceProfile;
  readonly records: readonly BurikoFileMetadataRecord[];
  /** Removed imported empty directories remain hidden if the backing retains their identity. */
  readonly removedDirectories?: readonly string[];
  readonly volumes: readonly BurikoFileMetadataVolume[];
  /** The same mounted case policy as the backing filesystem; no host path guessing. */
  readonly canonical: (path: string) => string;
  /** UTC FILETIME ticks from the actual wall-clock primitive, never frame ticks. */
  readonly currentFileTime: () => bigint;
  /** Filesystems differ: composition selects whether ordinary reads update access time. */
  readonly accessTimePolicy: 'disabled' | 'immediate';
}

function below(path: string, root: string): boolean {
  return root === '/' || path === root || path.startsWith(root + '/');
}
function parent(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash <= 0 ? '/' : path.slice(0, slash);
}
function unavailable(error: unknown): boolean {
  return error instanceof FileError && error.code === 'NOT_FOUND';
}

/** The mounted Windows metadata primitive surrounds the same real byte filesystem.
 * Empty directories and explicit imported metadata belong here, alongside all content writes.
 * It does not obtain timestamps or attributes from browser identity or monotonic frame state. */
export class BurikoMountedFileMetadata implements FileSystem {
  private readonly records = new Map<string, BurikoFileMetadataRecord>();
  private readonly names = new Map<string, BurikoNamespaceEntry>();
  private readonly removedDirectories = new Set<string>();
  private readonly volumes: readonly BurikoFileMetadataVolume[];
  constructor(
    private readonly backing: FileSystem,
    readonly profile: BurikoFileMetadataProfile,
  ) {
    for (const entry of profile.namespace?.entries ?? []) {
      const path = this.canonical(entry.path);
      this.names.set(path, {...entry, path});
    }
    this.volumes = profile.volumes
      .map((volume) => ({...volume, path: this.canonical(volume.path)}))
      .sort((a, b) => b.path.length - a.path.length);
    for (const record of profile.records) {
      const path = this.canonical(record.path);
      this.records.set(path, {
        ...record,
        path,
        attributes: record.attributes === null ? null : record.attributes >>> 0,
      });
    }
    for (const path of profile.removedDirectories ?? [])
      this.removedDirectories.add(this.canonical(path));
  }
  canonical(path: string): string {
    return filePath(this.profile.canonical(filePath(path)));
  }
  /** Mount a private browser source into this metadata owner's actual byte namespace. */
  mountSource(root: string, source: FileSystem): void {
    if (
      !(this.backing instanceof MountedFileSystem) ||
      root !== this.canonical(root) ||
      root === '/' ||
      root.indexOf('/', 1) !== -1 ||
      this.removed(root) ||
      [...this.records.keys()].some((path) => below(path, root)) ||
      [...this.names.keys()].some((path) => below(path, root)) ||
      [...this.removedDirectories].some((path) => below(path, root))
    )
      throw new FileError('INVALID_PATH', root);
    this.backing.mount(root, source);
  }
  volume(path: string): BurikoFileMetadataVolume | null {
    path = this.canonical(path);
    return this.volumes.find((volume) => below(path, volume.path)) ?? null;
  }
  assertWritable(path: string): void {
    if (this.volume(path)?.writable !== true) throw new FileError('READ_ONLY', path);
  }
  /** Owned snapshots can be persisted with the same selected mounted volume profile. */
  snapshot(): BurikoFileMetadataRecord[] {
    return [...this.records.values()].map((record) => ({...record}));
  }
  snapshotState(): {records: BurikoFileMetadataRecord[]; removedDirectories: string[]} {
    return {records: this.snapshot(), removedDirectories: [...this.removedDirectories]};
  }
  namespaceSnapshot(): BurikoNamespaceEntry[] {
    return [...this.names.values()].map((entry) => ({...entry}));
  }
  private registerName(path: string): void {
    if (this.profile.namespace === undefined) return;
    const canonical = this.canonical(path);
    if (!this.names.has(canonical))
      this.names.set(canonical, {
        path: canonical,
        name: filePath(path).slice(filePath(path).lastIndexOf('/') + 1),
        shortName: null,
      });
  }
  /** Find snapshots use actual children and the explicit imported namespace order. */
  async findEntries(path: string): Promise<(BurikoNamespaceEntry & FileInfo)[]> {
    if (this.profile.namespace === undefined)
      throw new Error('Buriko enumeration requires an explicit namespace profile');
    const children = await this.list(path),
      byPath = new Map(children.map((child) => [this.canonical(child.path), child]));
    for (const child of children)
      if (!this.names.has(this.canonical(child.path)))
        throw new Error(
          `Buriko enumeration lacks imported name/short-name/order metadata: ${child.path}`,
        );
    const result: (BurikoNamespaceEntry & FileInfo)[] = [];
    for (const entry of this.names.values()) {
      const child = byPath.get(entry.path);
      if (child !== undefined) result.push({...child, ...entry});
    }
    return result;
  }
  private removed(path: string): boolean {
    for (const directory of this.removedDirectories) if (below(path, directory)) return true;
    return false;
  }
  async stat(path: string): Promise<FileInfo> {
    path = this.canonical(path);
    if (this.removed(path)) throw new FileError('NOT_FOUND', path);
    const record = this.records.get(path);
    if (record?.kind === 'directory') return {path, kind: 'directory', size: 0};
    return this.backing.stat(path);
  }
  async list(path: string): Promise<FileInfo[]> {
    path = this.canonical(path);
    if ((await this.stat(path)).kind !== 'directory') throw new FileError('NOT_DIRECTORY', path);
    const children = new Map<string, FileInfo>();
    try {
      for (const child of await this.backing.list(path)) {
        const canonical = this.canonical(child.path);
        if (!this.removed(canonical)) children.set(canonical, child);
      }
    } catch (error) {
      if (!unavailable(error)) throw error;
    }
    for (const record of this.records.values())
      if (
        record.path !== path &&
        parent(record.path) === path &&
        record.kind === 'directory' &&
        !this.removed(record.path)
      )
        children.set(record.path, {path: record.path, kind: 'directory', size: 0});
    return [...children.values()].sort((a, b) =>
      a.path < b.path ? -1 : Number(a.path !== b.path),
    );
  }
  /** File timestamps are read only after the same mounted path is known to exist. */
  async metadata(path: string): Promise<BurikoFileMetadataRecord> {
    path = this.canonical(path);
    const info = await this.stat(path);
    let record = this.records.get(path);
    if (record === undefined) {
      record = {
        path,
        kind: info.kind,
        attributes: null,
        creationTime: null,
        accessTime: null,
        writeTime: null,
      };
      this.records.set(path, record);
    }
    return {...record};
  }
  async getTimes(path: string): Promise<BurikoFileTimes | null> {
    const record = await this.metadata(path);
    if (record.creationTime === null || record.accessTime === null || record.writeTime === null)
      return null;
    return {
      creationTime: record.creationTime,
      accessTime: record.accessTime,
      writeTime: record.writeTime,
    };
  }
  /** SetFileTime's zero-valued fields preserve the corresponding existing timestamp. */
  async setTimes(path: string, times: BurikoFileTimes): Promise<void> {
    path = this.canonical(path);
    this.assertWritable(path);
    const record = await this.metadata(path);
    for (const field of ['creationTime', 'accessTime', 'writeTime'] as const) {
      const value = BigInt.asUintN(64, times[field]);
      if (value !== 0n) record[field] = value;
    }
    this.records.set(path, record);
  }
  async getAttributes(path: string): Promise<number | null> {
    return (await this.metadata(path)).attributes;
  }
  /** SetFileAttributes changes supported mutable flags; the directory bit remains structural. */
  async setAttributes(path: string, attributes: number): Promise<void> {
    path = this.canonical(path);
    this.assertWritable(path);
    const record = await this.metadata(path),
      mutable = 0x3127;
    attributes >>>= 0;
    // Compression/encryption/reparse state require their own filesystem primitives.
    if ((attributes & ~(mutable | 0x80 | 0x10)) !== 0) throw new FileError('INVALID_PATH', path);
    const structural = record.kind === 'directory' ? 0x10 : 0;
    const immutable = (record.attributes ?? 0) & ~(mutable | 0x80 | 0x10);
    const flags = (attributes & mutable) | structural | immutable;
    record.attributes = flags === 0 ? 0x80 : flags;
    this.records.set(path, record);
  }
  async open(path: string): Promise<ByteSource> {
    path = this.canonical(path);
    if ((await this.stat(path)).kind === 'directory') throw new FileError('IS_DIRECTORY', path);
    const source = await this.backing.open(path);
    if (this.profile.accessTimePolicy === 'disabled') return source;
    return {
      size: source.size,
      read: async (offset, length) => {
        const result = await source.read(offset, length);
        if (result.length !== 0) {
          const record = await this.metadata(path);
          record.accessTime = BigInt.asUintN(64, this.profile.currentFileTime());
          this.records.set(path, record);
        }
        return result;
      },
    };
  }
  /** OPEN_ALWAYS preloads the browser's atomic-output snapshot without simulating a native ReadFile. */
  async openOutputContents(path: string): Promise<ByteSource> {
    path = this.canonical(path);
    if ((await this.stat(path)).kind === 'directory') throw new FileError('IS_DIRECTORY', path);
    return this.backing.open(path);
  }
  async commit(changes: readonly FileChange[]): Promise<void> {
    await this.commitFiles(changes, false);
  }
  /** OPEN_ALWAYS's permission check must not change an already existing file's times or flags. */
  async commitPreservingTimes(changes: readonly FileChange[]): Promise<void> {
    await this.commitFiles(changes, true);
  }
  private async commitFiles(changes: readonly FileChange[], preserve: boolean): Promise<void> {
    if (changes.length === 0) return;
    const prepared = changes.map((change) => ({...change, path: this.canonical(change.path)}));
    const before = new Map<string, BurikoFileMetadataRecord | null>();
    for (const change of prepared) {
      this.assertWritable(change.path);
      let record: BurikoFileMetadataRecord | null = null;
      try {
        record = await this.metadata(change.path);
      } catch (error) {
        if (!unavailable(error)) throw error;
      }
      if (record?.kind === 'directory') throw new FileError('IS_DIRECTORY', change.path);
      if (record?.attributes !== null && record !== null && (record.attributes & 1) !== 0)
        throw new FileError('READ_ONLY', change.path);
      before.set(change.path, record);
      const directory = await this.metadata(parent(change.path));
      if (directory.kind !== 'directory') throw new FileError('NOT_DIRECTORY', directory.path);
    }
    await this.backing.commit(prepared);
    const now = BigInt.asUintN(64, this.profile.currentFileTime());
    for (const [index, change] of prepared.entries()) {
      const old = before.get(change.path) ?? null;
      if (change.kind === 'delete') {
        this.records.delete(change.path);
        this.names.delete(change.path);
        before.set(change.path, null);
      } else {
        const record: BurikoFileMetadataRecord =
          old === null
            ? {
                path: change.path,
                kind: 'file',
                attributes: 0x20,
                creationTime: now,
                accessTime: now,
                writeTime: now,
              }
            : {...old};
        if (!preserve) {
          record.writeTime = now;
          if (record.attributes !== null)
            record.attributes = ((record.attributes & ~0x80) | 0x20) >>> 0;
        }
        if (old === null) this.registerName(changes[index]!.path);
        this.records.set(change.path, record);
        before.set(change.path, record);
      }
      if (old === null || change.kind === 'delete') {
        const directory = this.records.get(parent(change.path))!;
        directory.writeTime = now;
      }
    }
  }
  /** DeleteFileW over the selected mounted filesystem and this same metadata owner. */
  async deleteFile(path: string): Promise<void> {
    path = this.canonical(path);
    this.assertWritable(path);
    const record = await this.metadata(path);
    if (record.kind === 'directory') throw new FileError('IS_DIRECTORY', path);
    await this.commit([{kind: 'delete', path}]);
  }
  /** Installer DeleteFileW then same-volume MoveFileW, committed atomically by the backing owner. */
  async replaceFile(sourcePath: string, destinationPath: string): Promise<void> {
    const destinationSpelling = destinationPath;
    sourcePath = this.canonical(sourcePath);
    destinationPath = this.canonical(destinationPath);
    if (sourcePath === destinationPath) throw new FileError('INVALID_PATH', sourcePath);
    this.assertWritable(sourcePath);
    this.assertWritable(destinationPath);
    const sourceVolume = this.volume(sourcePath),
      destinationVolume = this.volume(destinationPath);
    if (
      sourceVolume === null ||
      destinationVolume === null ||
      sourceVolume.identity !== destinationVolume.identity
    )
      throw new FileError('CROSS_MOUNT', sourcePath);

    const source = await this.metadata(sourcePath);
    if (source.kind === 'directory') throw new FileError('IS_DIRECTORY', sourcePath);
    if (source.attributes !== null && (source.attributes & 1) !== 0)
      throw new FileError('READ_ONLY', sourcePath);
    const destinationDirectory = await this.metadata(parent(destinationPath));
    if (destinationDirectory.kind !== 'directory')
      throw new FileError('NOT_DIRECTORY', destinationDirectory.path);

    let destination: BurikoFileMetadataRecord | null = null;
    try {
      destination = await this.metadata(destinationPath);
    } catch (error) {
      if (!unavailable(error)) throw error;
    }
    if (destination?.kind === 'directory') throw new FileError('IS_DIRECTORY', destinationPath);
    if (
      destination !== null &&
      destination.attributes !== null &&
      (destination.attributes & 1) !== 0
    )
      throw new FileError('READ_ONLY', destinationPath);

    const opened = await this.backing.open(sourcePath),
      bytes = new Uint8Array(await opened.read(0, opened.size)),
      changes: FileChange[] = [];
    if (destination !== null) changes.push({kind: 'delete', path: destinationPath});
    changes.push(
      {kind: 'write', path: destinationPath, data: bytes},
      {kind: 'delete', path: sourcePath},
    );
    await this.backing.commit(changes);

    this.names.delete(sourcePath);
    this.names.delete(destinationPath);
    this.registerName(destinationSpelling);
    this.records.delete(sourcePath);
    this.records.set(destinationPath, {...source, path: destinationPath});
    const now = BigInt.asUintN(64, this.profile.currentFileTime()),
      parents = new Set([parent(sourcePath), parent(destinationPath)]);
    for (const directoryPath of parents) {
      const directory = await this.metadata(directoryPath);
      directory.writeTime = now;
      this.records.set(directoryPath, directory);
    }
  }
  /** CopyFileW(FALSE) within the explicitly selected ordinary-file metadata profile. */
  async copyPath(sourcePath: string, destinationPath: string): Promise<void> {
    if (this.profile.move === undefined)
      throw new Error('Buriko copy requires an explicit ordinary-file move/copy profile');
    const spelling = destinationPath;
    sourcePath = this.canonical(sourcePath);
    destinationPath = this.canonical(destinationPath);
    if (sourcePath === destinationPath) throw new FileError('INVALID_PATH', destinationPath);
    this.assertWritable(destinationPath);
    const source = await this.metadata(sourcePath);
    if (source.kind !== 'file') throw new FileError('IS_DIRECTORY', sourcePath);
    if (source.attributes !== null && (source.attributes & (0x400 | 0x800 | 0x4000)) !== 0)
      throw new Error('Buriko copy profile does not support reparse/compressed/encrypted contents');
    const directory = await this.metadata(parent(destinationPath));
    if (directory.kind !== 'directory') throw new FileError('NOT_DIRECTORY', directory.path);
    let destination: BurikoFileMetadataRecord | null = null;
    try {
      destination = await this.metadata(destinationPath);
    } catch (error) {
      if (!unavailable(error)) throw error;
    }
    if (destination !== null) {
      if (destination.kind !== 'file') throw new FileError('IS_DIRECTORY', destinationPath);
      if (destination.attributes === null)
        throw new Error('Buriko copy cannot determine destination hidden/readonly state');
      if ((destination.attributes & (0x400 | 0x800 | 0x4000)) !== 0)
        throw new Error(
          'Buriko copy profile does not support reparse/compressed/encrypted destination',
        );
      if ((destination.attributes & 3) !== 0) throw new FileError('READ_ONLY', destinationPath);
    }
    const opened = await this.backing.open(sourcePath);
    const bytes = new Uint8Array(await opened.read(0, opened.size));
    await this.backing.commit([{kind: 'write', path: destinationPath, data: bytes}]);
    this.removedDirectories.delete(destinationPath);
    this.records.set(destinationPath, {...source, path: destinationPath});
    if (destination === null) {
      this.registerName(spelling);
      directory.writeTime = BigInt.asUintN(64, this.profile.currentFileTime());
      this.records.set(directory.path, directory);
    }
  }
  /** Nonreplacing rename/cross-volume copy-delete over this same metadata and byte owner. */
  async movePath(sourcePath: string, destinationPath: string): Promise<void> {
    if (this.profile.move === undefined)
      throw new Error('Buriko move requires an explicit ordinary-file move profile');
    const destinationSpelling = destinationPath;
    sourcePath = this.canonical(sourcePath);
    destinationPath = this.canonical(destinationPath);
    if (sourcePath === destinationPath || below(destinationPath, sourcePath))
      throw new FileError('INVALID_PATH', destinationPath);
    const sourceVolume = this.volume(sourcePath),
      destinationVolume = this.volume(destinationPath);
    if (sourceVolume === null || destinationVolume === null)
      throw new FileError('NOT_FOUND', sourcePath);
    this.assertWritable(sourcePath);
    this.assertWritable(destinationPath);
    if (
      sourcePath === '/' ||
      sourceVolume.path === sourcePath ||
      destinationVolume.path === destinationPath
    )
      throw new FileError('INVALID_PATH', sourcePath);
    const root = await this.metadata(sourcePath);
    try {
      await this.stat(destinationPath);
      throw new FileError('INVALID_PATH', destinationPath);
    } catch (error) {
      if (!unavailable(error)) throw error;
    }
    const destinationParent = await this.metadata(parent(destinationPath));
    if (destinationParent.kind !== 'directory')
      throw new FileError('NOT_DIRECTORY', destinationParent.path);
    const sameVolume = sourceVolume.identity === destinationVolume.identity;
    if (!sameVolume && root.kind === 'directory') throw new FileError('CROSS_MOUNT', sourcePath);
    const records: BurikoFileMetadataRecord[] = [];
    const gather = async (path: string): Promise<void> => {
      if (
        this.volume(path)?.identity !== sourceVolume.identity ||
        (path !== sourcePath && this.volumes.some((volume) => volume.path === path))
      )
        throw new Error('Buriko move cannot transfer a nested mounted volume');
      const record = await this.metadata(path);
      if (record.attributes !== null && (record.attributes & (0x400 | 0x800 | 0x4000)) !== 0)
        throw new Error(
          'Buriko move profile does not support reparse/compressed/encrypted contents',
        );
      records.push(record);
      if (record.kind === 'directory')
        for (const child of await this.list(path)) await gather(child.path);
    };
    await gather(sourcePath);
    const names =
      this.profile.namespace === undefined
        ? []
        : records.map((record) => {
            const entry = this.names.get(record.path);
            if (entry === undefined)
              throw new Error('Buriko move lacks imported namespace metadata');
            return entry;
          });
    const sourceNames = new Set(names.map((entry) => entry.path));
    const orderedNames = [...this.names.values()].filter((entry) => sourceNames.has(entry.path));
    const changes: FileChange[] = [];
    for (const record of records)
      if (record.kind === 'file') {
        const opened = await this.backing.open(record.path);
        changes.push({
          kind: 'write',
          path: destinationPath + record.path.slice(sourcePath.length),
          data: new Uint8Array(await opened.read(0, opened.size)),
        });
      }
    const now = BigInt.asUintN(64, this.profile.currentFileTime());
    if (!sameVolume) {
      // Separate commits are essential: the backing rejects cross-mount atomic batches.
      await this.backing.commit(changes);
      this.removedDirectories.delete(destinationPath);
      this.records.set(destinationPath, {...root, path: destinationPath});
      this.registerName(destinationSpelling);
      destinationParent.writeTime = now;
      this.records.set(destinationParent.path, destinationParent);
      try {
        await this.deleteFile(sourcePath);
      } catch (error) {
        if (!(error instanceof FileError || error instanceof DOMException)) throw error;
        // Selected COPY_ALLOWED policy: copied destination survives, source remains on delete failure.
      }
      return;
    }
    for (const record of records)
      if (record.kind === 'file') changes.push({kind: 'delete', path: record.path});
    await this.backing.commit(changes);
    for (const record of records) {
      this.records.delete(record.path);
      this.names.delete(record.path);
      const path = destinationPath + record.path.slice(sourcePath.length);
      this.removedDirectories.delete(path);
      this.records.set(path, {...record, path});
    }
    for (const record of records)
      if (record.kind === 'directory') this.removedDirectories.add(record.path);
    this.registerName(destinationSpelling);
    for (const entry of orderedNames)
      if (entry.path !== sourcePath) {
        const path = destinationPath + entry.path.slice(sourcePath.length);
        this.names.set(path, {...entry, path});
      }
    for (const directoryPath of new Set([parent(sourcePath), parent(destinationPath)])) {
      const directory = await this.metadata(directoryPath);
      directory.writeTime = now;
      this.records.set(directoryPath, directory);
    }
  }
  /** Concrete empty directories have no backing byte record; the same owner exposes them to stat/list. */
  async createDirectory(path: string): Promise<void> {
    const spelling = path;
    path = this.canonical(path);
    this.assertWritable(path);
    try {
      await this.stat(path);
      throw new FileError('INVALID_PATH', path);
    } catch (error) {
      if (!unavailable(error)) throw error;
    }
    const directory = await this.metadata(parent(path));
    if (directory.kind !== 'directory') throw new FileError('NOT_DIRECTORY', directory.path);
    const now = BigInt.asUintN(64, this.profile.currentFileTime());
    this.registerName(spelling);
    this.removedDirectories.delete(path);
    this.records.set(path, {
      path,
      kind: 'directory',
      attributes: 0x10,
      creationTime: now,
      accessTime: now,
      writeTime: now,
    });
    directory.writeTime = now;
    this.records.set(directory.path, directory);
  }
  async removeDirectory(path: string): Promise<void> {
    path = this.canonical(path);
    this.assertWritable(path);
    if (this.volume(path)?.path === path || path === '/') throw new FileError('INVALID_PATH', path);
    if ((await this.stat(path)).kind !== 'directory') throw new FileError('NOT_DIRECTORY', path);
    if ((await this.list(path)).length !== 0) throw new FileError('IS_DIRECTORY', path);
    this.names.delete(path);
    this.records.delete(path);
    this.removedDirectories.add(path);
    const directory = await this.metadata(parent(path));
    directory.writeTime = BigInt.asUintN(64, this.profile.currentFileTime());
    this.records.set(directory.path, directory);
  }
}

import type {ByteSource} from '../../../../../core/source.js';
import {
  FileError,
  filePath,
  type FileChange,
  type FileInfo,
  type FileSystem,
} from '../../../../../platform/filesystem.js';

export interface AokanaFileTimes {
  readonly creationTime: bigint;
  readonly accessTime: bigint;
  readonly writeTime: bigint;
}
export interface AokanaFileMetadataRecord {
  readonly path: string;
  readonly kind: 'file' | 'directory';
  /** Unknown imported attributes and times remain unknown until an actual write supplies them. */
  attributes: number | null;
  creationTime: bigint | null;
  accessTime: bigint | null;
  writeTime: bigint | null;
}
export interface AokanaFileMetadataVolume {
  readonly path: string;
  readonly identity: object;
  readonly writable: boolean;
}
export interface AokanaFileMetadataProfile {
  readonly records: readonly AokanaFileMetadataRecord[];
  /** Removed imported empty directories remain hidden if the backing retains their identity. */
  readonly removedDirectories?: readonly string[];
  readonly volumes: readonly AokanaFileMetadataVolume[];
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
export class AokanaMountedFileMetadata implements FileSystem {
  private readonly records = new Map<string, AokanaFileMetadataRecord>();
  private readonly removedDirectories = new Set<string>();
  private readonly volumes: readonly AokanaFileMetadataVolume[];
  constructor(
    private readonly backing: FileSystem,
    readonly profile: AokanaFileMetadataProfile,
  ) {
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
  volume(path: string): AokanaFileMetadataVolume | null {
    path = this.canonical(path);
    return this.volumes.find((volume) => below(path, volume.path)) ?? null;
  }
  assertWritable(path: string): void {
    if (this.volume(path)?.writable !== true) throw new FileError('READ_ONLY', path);
  }
  /** Owned snapshots can be persisted with the same selected mounted volume profile. */
  snapshot(): AokanaFileMetadataRecord[] {
    return [...this.records.values()].map((record) => ({...record}));
  }
  snapshotState(): {records: AokanaFileMetadataRecord[]; removedDirectories: string[]} {
    return {records: this.snapshot(), removedDirectories: [...this.removedDirectories]};
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
  async metadata(path: string): Promise<AokanaFileMetadataRecord> {
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
  async getTimes(path: string): Promise<AokanaFileTimes | null> {
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
  async setTimes(path: string, times: AokanaFileTimes): Promise<void> {
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
    const before = new Map<string, AokanaFileMetadataRecord | null>();
    for (const change of prepared) {
      this.assertWritable(change.path);
      let record: AokanaFileMetadataRecord | null = null;
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
    for (const change of prepared) {
      const old = before.get(change.path) ?? null;
      if (change.kind === 'delete') {
        this.records.delete(change.path);
        before.set(change.path, null);
      } else {
        const record: AokanaFileMetadataRecord =
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
  /** MoveFileW's same-volume replacement transfers the source file and its metadata. */
  async replaceFile(sourcePath: string, destinationPath: string): Promise<void> {
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

    let destination: AokanaFileMetadataRecord | null = null;
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
  /** Concrete empty directories have no backing byte record; the same owner exposes them to stat/list. */
  async createDirectory(path: string): Promise<void> {
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
    this.records.delete(path);
    this.removedDirectories.add(path);
    const directory = await this.metadata(parent(path));
    directory.writeTime = BigInt.asUintN(64, this.profile.currentFileTime());
    this.records.set(directory.path, directory);
  }
}

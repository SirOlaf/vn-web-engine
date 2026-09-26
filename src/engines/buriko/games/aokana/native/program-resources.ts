import {FileError} from '../../../../../platform/filesystem.js';
import type {AokanaBpModuleResourceSource} from './types.js';
import {pointerView, type AokanaBpPointer} from '../bp/memory.js';
import {AokanaProgramArchives, type AokanaArchiveResource} from './program-archives.js';
import {AokanaProgramFiles, terminatedNativeBytes} from './program-files.js';
import {AokanaEngineDialogs, AokanaNativeExit} from './engine-dialogs.js';
import {
  AokanaUndefinedResourceRead,
  decodeAokanaResource,
  type AokanaResourceDestination,
} from './resource-decode.js';
import {assertAokanaPathDomain} from './path-domain.js';
import {textBytes, textLength, writeText} from './text.js';
import {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaDistributedProcessing} from './distributed-processing.js';
import type {AokanaSelectionDialog} from './selection-dialog.js';

function bounded(path: string, capacity = 784, checkDomain = true): string {
  if (path.length >= capacity)
    throw new RangeError('Aokana availability path exceeds native wide scratch');
  if (checkDomain) assertAokanaPathDomain(path);
  return path;
}

/** Native archive pointers are not dereferenced when primary loose lookup succeeds. */
export type AokanaArchiveName = Uint8Array | (() => Uint8Array);

function archiveBytes(archive: AokanaArchiveName): Uint8Array {
  return typeof archive === 'function' ? archive() : archive;
}

export interface AokanaProgramResourceConfiguration {
  /** WCHAR buffer DAT_1401e81b0, used by direct font/audio OS file paths. */
  nativeFileRoot: string;
  /** Byte buffer DAT_1401e7170. */
  primaryRoot: Uint8Array;
  secondaryRoot: Uint8Array;
  /** DAT_1401e7480, already wide in the native executable. */
  secondaryMediaPath: string;
  searchDirectoriesEnabled: number;
  searchDirectories: Uint8Array[];
  retryTitle: Uint8Array;
  retryMessage: Uint8Array;
  quitConfirmation: Uint8Array;
}

/** Native resource lookup shared by FF, module loading, and title resource services. */
export class AokanaProgramResources implements AokanaBpModuleResourceSource {
  readonly archives: AokanaProgramArchives;
  constructor(
    readonly files: AokanaProgramFiles,
    readonly configuration: AokanaProgramResourceConfiguration,
    readonly dialogs: AokanaEngineDialogs,
    readonly errors: AokanaEngineErrors,
    readonly mainProcessing: AokanaDistributedProcessing,
  ) {
    this.archives = new AokanaProgramArchives(files, errors, mainProcessing);
  }

  /** ECB90 BC240(1) then BC1E0: restore search policy and clear the same
   * directory list used by 80:36/37 and loose resource lookups. */
  resetDirectorySearchForProgram(): void {
    this.configuration.searchDirectoriesEnabled = 1;
    this.configuration.searchDirectories.length = 0;
  }

  /** E8F80 updates both shared primary-root globals after the actual directory check. */
  async setPrimaryRoot(path: AokanaBpPointer): Promise<0 | 1> {
    const wide = this.files.text.decodeAuto(path);
    assertAokanaPathDomain(wide);
    if (!(await this.files.isDirectoryWide(wide))) return 0;
    const original = textBytes(path);
    if (original.length + 2 > 784)
      throw new RangeError('Aokana primary root exceeds native byte buffer');
    const encoded = new Uint8Array(original.length + 2);
    encoded.set(original);
    encoded[original.length] = 92;
    // The native sprintf always appends a slash, even to a caller's trailing slash.
    this.configuration.primaryRoot = encoded;
    const decoded = this.files.text.decodeAuto({bytes: encoded, offset: 0});
    if (decoded.length >= 784)
      throw new RangeError('Aokana primary root exceeds native wide buffer');
    this.configuration.nativeFileRoot = decoded;
    return 1;
  }

  private convert(bytes: Uint8Array, mode: number): Uint8Array {
    return this.files.text.convertEncoding({bytes: terminatedNativeBytes(bytes), offset: 0}, mode);
  }

  private concatenate(
    first: Uint8Array,
    second: Uint8Array,
    separator: boolean,
    capacity: number,
  ): Uint8Array {
    const a = textBytes({bytes: first, offset: 0});
    const b = textBytes({bytes: second, offset: 0}, true);
    const length = a.length + Number(separator) + b.length;
    if (length > capacity)
      throw new RangeError('Aokana native resource path exceeds scratch storage');
    const result = new Uint8Array(length);
    result.set(a);
    if (separator) result[a.length] = 92;
    result.set(b, a.length + Number(separator));
    return result;
  }

  /** 1400bd370 converts both pieces to UTF-8; only the middle-directory call inserts a slash. */
  loosePath(root: Uint8Array, resource: Uint8Array, separator = false): Uint8Array {
    return this.concatenate(this.convert(root, 1), this.convert(resource, 1), separator, 784);
  }

  /** 1400f7e30 uses the ROOT's detected encoding for both pieces and sprintf("%s%s"). */
  archivePath(root: Uint8Array, archive: Uint8Array): Uint8Array {
    const mode = this.files.text.detectEncoding(terminatedNativeBytes(root));
    return this.concatenate(this.convert(root, mode), this.convert(archive, mode), false, 1040);
  }

  private async looseFile(
    path: Uint8Array,
    offset = 0,
    length = 0,
    destination?: AokanaResourceDestination | null,
    actor = this.mainProcessing.allocator.currentActor,
  ): Promise<AokanaArchiveResource> {
    if (!this.files.isAvailable(path)) return {result: 1, bytes: null};
    const opened = await this.files.open(path);
    if (opened.source === null) return {result: 1, bytes: null};
    const size = opened.source.size >>> 0;
    if (size > 0x4000000) return {result: 6, bytes: null};
    let stored: Uint8Array;
    try {
      stored = await this.files.read(opened.source, 0, size);
    } catch (error) {
      if (error instanceof FileError || error instanceof DOMException)
        return {result: 5, bytes: null};
      throw error;
    }
    if (stored.length !== size) return {result: 5, bytes: null};
    const decoded = await decodeAokanaResource(
      stored,
      this.mainProcessing,
      offset,
      length,
      destination,
      undefined,
      actor,
    );
    return {result: decoded.status, bytes: decoded.bytes, initialized: decoded.initialized};
  }

  private async loose(
    root: Uint8Array,
    name: Uint8Array,
    destination?: AokanaResourceDestination | null,
    actor = this.mainProcessing.allocator.currentActor,
  ): Promise<AokanaArchiveResource | null> {
    const terminated = terminatedNativeBytes(name);
    const absolute = terminated[0] === 92 || terminated[1] === 58;
    let result = await this.looseFile(
      absolute ? terminated : this.loosePath(root, terminated),
      0,
      0,
      destination,
      actor,
    );
    if (!absolute && result.result === 1 && this.configuration.searchDirectoriesEnabled !== 0) {
      for (const directory of this.configuration.searchDirectories) {
        result = await this.looseFile(
          this.loosePath(this.loosePath(root, directory), terminated, true),
          0,
          0,
          destination,
          actor,
        );
        if (result.result !== 1) break;
      }
    }
    // bda60 collapses every loose decoder failure (including empty files) into size zero.
    return result.result === 0 && result.bytes !== null && result.bytes.length !== 0
      ? {result: result.bytes.length, bytes: result.bytes, initialized: result.initialized}
      : null;
  }

  /** BA450 selects the configured root, then copies names or reports their packed byte size. */
  async enumerateArchiveNames(
    packedNames: AokanaBpPointer | null,
    outputValue: AokanaBpPointer,
    archivePath: Uint8Array,
  ): Promise<0 | 1> {
    const path = terminatedNativeBytes(archivePath);
    const absolute = path[0] === 92 || path[1] === 58;
    const names = await this.archives.enumerateNames(
      absolute ? path : this.loosePath(this.configuration.primaryRoot, path),
    );
    if (names === null) return 1;
    let value = 0;
    if (packedNames === null) {
      for (const name of names) value = (value + name.length) >>> 0;
    } else {
      for (const name of names) {
        writeText({bytes: packedNames.bytes, offset: packedNames.offset + value}, name);
        value = (value + name.length) >>> 0;
      }
      value = names.length >>> 0;
    }
    pointerView(outputValue, 4).setUint32(0, value, true);
    return 0;
  }

  /** BA5C0 builds the archive index names into its count*0x60 newline-list allocation. */
  async selectArchiveEntry(
    selection: AokanaSelectionDialog,
    output: AokanaBpPointer | null,
    title: AokanaBpPointer | null,
    prompt: AokanaBpPointer | null,
    archivePath: Uint8Array,
  ): Promise<0 | 1 | 0xffffffff> {
    const path = terminatedNativeBytes(archivePath),
      absolute = path[0] === 92 || path[1] === 58;
    const names = await this.archives.enumerateNames(
      absolute ? path : this.archivePath(this.configuration.primaryRoot, path),
    );
    if (names === null) return 1;
    const list = new Uint8Array(Math.imul(names.length, 0x60) >>> 0);
    let offset = 0;
    for (const name of names) {
      const bytes = textBytes({bytes: name, offset: 0});
      if (offset + bytes.length + 2 > list.length)
        throw new RangeError('Aokana archive selection list exceeds its native allocation');
      list.set(bytes, offset);
      offset += bytes.length;
      list[offset++] = 10;
      list[offset] = 0;
    }
    return (await selection.select(output, title, prompt, {bytes: list, offset: 0})) === 0
      ? 0xffffffff
      : 0;
  }

  /** B9AF0 releases the primary cache node, with secondary media fallback only for a missing archive. */
  async releaseArchive(archive: Uint8Array): Promise<0 | 1> {
    let result = await this.archives.release(
      this.archivePath(this.configuration.primaryRoot, archive),
    );
    if (
      result === 0x80000010 &&
      this.files.media.isAvailable(this.configuration.secondaryMediaPath)
    ) {
      result = await this.archives.release(
        this.archivePath(this.configuration.secondaryRoot, archive),
      );
    }
    return result === 0 ? 0 : 1;
  }

  private async retry(archive: AokanaArchiveName | null, name: Uint8Array): Promise<void> {
    // bd7d0 prepares its error text before bbc90 decides between a fatal error and a media dialog.
    const diagnosticArchive = archive === null ? null : archiveBytes(archive);
    if (
      textLength({bytes: terminatedNativeBytes(this.configuration.secondaryRoot), offset: 0}) === 0
    ) {
      const resource = this.files.path(name);
      const item =
        diagnosticArchive === null
          ? resource
          : `${this.files.path(diagnosticArchive)} : ${resource}`;
      return this.errors.fatal(
        this.files.text.encodeWide(`指定されたファイル [ ${item} ] は存在しません`, 1),
      );
    }
    await this.mediaRetryDialog();
  }

  /** BBC90 consumes the prepared diagnostic only when the native root byte is empty. */
  async requestMediaRetry(diagnostic: Uint8Array): Promise<void> {
    if (this.configuration.secondaryRoot.length === 0)
      throw new Error('Aokana media retry reads absent secondary-root storage');
    if (this.configuration.secondaryRoot[0] === 0) return this.errors.fatal(diagnostic);
    await this.mediaRetryDialog();
  }

  /** Shared actual dialog/exit/sleep portion; legacy generic retry retains its own formatting. */
  private async mediaRetryDialog(): Promise<void> {
    const answer = await this.dialogs.show(
      this.configuration.retryMessage,
      this.configuration.retryTitle,
      0x41,
    );
    if (answer === 2) {
      if (
        (await this.dialogs.show(
          this.configuration.quitConfirmation,
          this.configuration.retryTitle,
          0x124,
        )) === 6
      ) {
        throw new AokanaNativeExit(0x7fffffff, 'Aokana resource retry cancelled');
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  /** 1400bd7d0: primary loose, then secondary loose OR the archive/cache fallback loop. */
  async load(
    archive: AokanaArchiveName | null,
    name: Uint8Array,
    retry: boolean,
    destination?: AokanaResourceDestination | null,
    actor = this.mainProcessing.allocator.currentActor,
  ): Promise<AokanaArchiveResource> {
    const primary = await this.loose(this.configuration.primaryRoot, name, destination, actor);
    if (primary !== null) return primary;
    if (archive === null) {
      for (;;) {
        const secondary = await this.loose(
          this.configuration.secondaryRoot,
          name,
          destination,
          actor,
        );
        if (secondary !== null) return secondary;
        if (!retry) return {result: 0, bytes: null};
        await this.retry(null, name);
      }
    }
    let result = await this.archives.resource(
      this.archivePath(this.configuration.primaryRoot, archiveBytes(archive)),
      name,
      0,
      0,
      destination,
      actor,
    );
    while (result.result === 0x80000010 || result.result === 0x80000020) {
      if (this.files.media.isAvailable(this.configuration.secondaryMediaPath)) {
        result = await this.archives.resource(
          this.archivePath(this.configuration.secondaryRoot, archiveBytes(archive)),
          name,
          0,
          0,
          destination,
          actor,
        );
      }
      if (result.result === 0x80000010 || result.result === 0x80000020) {
        if (!retry) return {result: 0, bytes: null};
        await this.retry(archive, name);
      }
    }
    return result;
  }

  /** BBD80/BC030 preserve decoder statuses for the BBAB0 partial-load path. */
  async partialLoose(
    root: Uint8Array | null,
    name: Uint8Array,
    offset: number,
    length: number,
    destination?: AokanaResourceDestination | null,
    actor = this.mainProcessing.allocator.currentActor,
  ): Promise<AokanaArchiveResource> {
    const terminated = terminatedNativeBytes(name);
    if (terminated[0] === 92 || terminated[1] === 58)
      return this.looseFile(terminated, offset, length, destination, actor);
    if (root === null)
      throw new Error('Aokana relative loose resource path converts a null native root');
    let result = await this.looseFile(
      this.loosePath(root, terminated),
      offset,
      length,
      destination,
      actor,
    );
    if (this.configuration.searchDirectoriesEnabled !== 0)
      for (const directory of this.configuration.searchDirectories) {
        if (result.result !== 1) break;
        result = await this.looseFile(
          this.loosePath(this.loosePath(root, directory), terminated, true),
          offset,
          length,
          destination,
          actor,
        );
      }
    return result;
  }

  /** BBAB0: primary loose, then secondary loose or archive fallback; success is status zero. */
  async loadPartial(
    archive: AokanaArchiveName | null,
    name: Uint8Array,
    offset: number,
    length: number,
    destination?: AokanaResourceDestination | null,
    actor = this.mainProcessing.allocator.currentActor,
  ): Promise<AokanaArchiveResource> {
    let result = await this.partialLoose(
      this.configuration.primaryRoot,
      name,
      offset,
      length,
      destination,
      actor,
    );
    if (result.result !== 1) return result;
    if (archive === null)
      return this.partialLoose(
        this.configuration.secondaryRoot,
        name,
        offset,
        length,
        destination,
        actor,
      );
    const archiveName = archiveBytes(archive);
    const path = (root: Uint8Array): Uint8Array => {
      const value = this.archivePath(root, archiveName);
      if (value.length > 784)
        throw new RangeError('Aokana partial resource archive path exceeds native scratch');
      return value;
    };
    result = await this.archives.resource(
      path(this.configuration.primaryRoot),
      name,
      offset,
      length,
      destination,
      actor,
    );
    if (
      (result.result === 0x80000010 || result.result === 0x80000020) &&
      this.files.media.isAvailable(this.configuration.secondaryMediaPath)
    )
      result = await this.archives.resource(
        path(this.configuration.secondaryRoot),
        name,
        offset,
        length,
        destination,
        actor,
      );
    const statuses: Readonly<Record<number, number>> = {
      0x80000010: 1,
      0x80000020: 1,
      0x80000030: 2,
      0x80000040: 3,
      0x80000050: 5,
      0x80000060: 6,
    };
    return {...result, result: statuses[result.result] ?? 0};
  }

  private async relativePath(root: string, name: AokanaBpPointer): Promise<string | null> {
    const files = this.files,
      configuration = this.configuration;
    if (!files.media.isAvailable(root)) return null;
    const decoded = this.files.text.decodeAuto(name);
    assertAokanaPathDomain(root);
    assertAokanaPathDomain(decoded);
    if (decoded.length >= 784)
      throw new RangeError('Aokana relative name exceeds native wide scratch');
    const direct = bounded(root + decoded, 784, false);
    if (await files.isFileWide(direct)) return direct;
    if (configuration.searchDirectoriesEnabled !== 0)
      for (const directory of configuration.searchDirectories) {
        const middle = root + files.path(directory);
        bounded(middle, 780, false);
        const path = bounded(middle + '\\' + decoded, 784, false);
        if (await files.isFileWide(path)) return path;
      }
    return null;
  }

  /** BB3C0's nonnull output branch encodes the resolved wide path in UTF8. */
  async findRelativeFile(root: string, name: AokanaBpPointer): Promise<Uint8Array | null> {
    const path = await this.relativePath(root, name);
    return path === null ? null : this.files.text.encodeWide(path, 1);
  }

  /** BA330: raw entry, independent physical-name lookup, then independent payload base. */
  async locateArchiveEntry(
    archive: Uint8Array,
    name: Uint8Array,
  ): Promise<{
    path: Uint8Array;
    record: Uint8Array;
  } | null> {
    const configuration = this.configuration;
    let path = this.archivePath(configuration.primaryRoot, archive);
    if (path.length > 784)
      throw new RangeError('Aokana archive locator path exceeds native scratch');
    let record = await this.archives.copyEntry(path, name);
    if (record === null) {
      if (!this.files.media.isAvailable(configuration.secondaryMediaPath)) return null;
      path = this.archivePath(configuration.secondaryRoot, archive);
      if (path.length > 784)
        throw new RangeError('Aokana archive locator path exceeds native scratch');
      record = await this.archives.copyEntry(path, name);
      if (record === null) return null;
    }
    const physical = await this.archives.entryPath(path, name);
    if (physical === null)
      throw new AokanaUndefinedResourceRead(
        'Aokana archive locator consumes unwritten physical path',
      );
    const base = await this.archives.payloadBase(physical);
    if (base === null)
      throw new AokanaUndefinedResourceRead(
        'Aokana archive locator consumes unwritten payload base',
      );
    const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
    view.setUint32(96, (view.getUint32(96, true) + base) >>> 0, true);
    return {path: physical, record};
  }
  async isAvailable(archive: AokanaArchiveName | null, name: AokanaBpPointer): Promise<number> {
    const pointer = name,
      files = this.files,
      config = this.configuration;
    if (
      archive === null &&
      (textBytes(pointer, true)[0] === 92 || textBytes(pointer, true)[1] === 58)
    ) {
      const wide = bounded(this.files.text.decodeAuto(pointer), 788);
      return Number(files.media.isAvailable(wide) && (await files.isFileWide(wide)));
    }
    if ((await this.relativePath(config.nativeFileRoot, pointer)) !== null) return 1;
    if (archive === null)
      return Number((await this.relativePath(config.secondaryMediaPath, pointer)) !== null);
    const archiveBytes = typeof archive === 'function' ? archive() : archive;
    const path = (root: Uint8Array): Uint8Array => {
      const result = this.archivePath(root, archiveBytes);
      if (result.length > 784)
        throw new RangeError('Aokana availability archive path exceeds native scratch');
      return result;
    };
    const filename = textBytes(pointer);
    if (await this.archives.contains(path(config.primaryRoot), filename)) return 1;
    return Number(
      files.media.isAvailable(config.secondaryMediaPath) &&
        (await this.archives.contains(path(config.secondaryRoot), filename)),
    );
  }

  /** 1400bd6b0 really loads/decodes and frees the bytes; its fallback differs from bd7d0. */
  async size(
    archive: AokanaArchiveName | null,
    name: Uint8Array,
    actor = this.mainProcessing.allocator.currentActor,
  ): Promise<number> {
    const primary = await this.loose(this.configuration.primaryRoot, name, undefined, actor);
    if (primary !== null) return primary.result;
    if (archive === null)
      return (
        (await this.loose(this.configuration.secondaryRoot, name, undefined, actor))?.result ?? 0
      );
    let result = await this.archives.resource(
      this.archivePath(this.configuration.primaryRoot, archiveBytes(archive)),
      name,
      0,
      0,
      undefined,
      actor,
    );
    if (
      result.result === 0x80000010 &&
      this.files.media.isAvailable(this.configuration.secondaryMediaPath)
    ) {
      result = await this.archives.resource(
        this.archivePath(this.configuration.secondaryRoot, archiveBytes(archive)),
        name,
        0,
        0,
        undefined,
        actor,
      );
    }
    return result.result < 0x80000000 ? result.result : 0;
  }

  async readModule(
    archive: Uint8Array | null,
    name: Uint8Array,
    retry = true,
    actor = this.mainProcessing.allocator.currentActor,
  ): Promise<Uint8Array | null> {
    const result = await this.load(archive, name, retry, undefined, actor);
    if (result.result === 0) return null;
    if (result.bytes === null) {
      // Native callers regard these high-bit archive errors as nonzero sizes, then dereference
      // an unwritten resource pointer. Do not turn that path into success or a missing resource.
      throw new AokanaUndefinedResourceRead(
        `Aokana module reader consumes archive error 0x${result.result.toString(16)} as a resource`,
      );
    }
    return result.bytes;
  }
}

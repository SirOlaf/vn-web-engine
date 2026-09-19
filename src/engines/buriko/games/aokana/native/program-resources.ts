import type {AokanaBpModuleResourceSource} from './types.js';
import {pointerView, type AokanaBpPointer} from '../bp/memory.js';
import {AokanaProgramArchives, type AokanaArchiveResource} from './program-archives.js';
import {AokanaProgramFiles, terminatedNativeBytes} from './program-files.js';
import {AokanaEngineDialogs, AokanaNativeExit} from './engine-dialogs.js';
import {AokanaUndefinedResourceRead, decodeAokanaResource} from './resource-decode.js';
import {textBytes, textLength, writeText} from './text.js';
import {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaDistributedProcessing} from './distributed-processing.js';
import type {AokanaSelectionDialog} from './selection-dialog.js';

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

  private async looseFile(path: Uint8Array): Promise<AokanaArchiveResource> {
    if (!this.files.isAvailable(path)) return {result: 1, bytes: null};
    const opened = await this.files.open(path);
    if (opened.source === null) return {result: 1, bytes: null};
    const size = opened.source.size >>> 0;
    if (size > 0x4000000) return {result: 6, bytes: null};
    const stored = await this.files.read(opened.source, 0, size);
    if (stored.length !== size) return {result: 5, bytes: null};
    const decoded = await decodeAokanaResource(stored, this.mainProcessing);
    return {result: decoded.status, bytes: decoded.bytes};
  }

  private async loose(root: Uint8Array, name: Uint8Array): Promise<Uint8Array | null> {
    const terminated = terminatedNativeBytes(name);
    const absolute = terminated[0] === 92 || terminated[1] === 58;
    let result = await this.looseFile(absolute ? terminated : this.loosePath(root, terminated));
    if (!absolute && result.result === 1 && this.configuration.searchDirectoriesEnabled !== 0) {
      for (const directory of this.configuration.searchDirectories) {
        result = await this.looseFile(
          this.loosePath(this.loosePath(root, directory), terminated, true),
        );
        if (result.result !== 1) break;
      }
    }
    // bda60 collapses every loose decoder failure (including empty files) into size zero.
    return result.result === 0 && result.bytes !== null && result.bytes.length !== 0
      ? result.bytes
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
  ): Promise<AokanaArchiveResource> {
    const primary = await this.loose(this.configuration.primaryRoot, name);
    if (primary !== null) return {result: primary.length, bytes: primary};
    if (archive === null) {
      for (;;) {
        const secondary = await this.loose(this.configuration.secondaryRoot, name);
        if (secondary !== null) return {result: secondary.length, bytes: secondary};
        if (!retry) return {result: 0, bytes: null};
        await this.retry(null, name);
      }
    }
    let result = await this.archives.resource(
      this.archivePath(this.configuration.primaryRoot, archiveBytes(archive)),
      name,
    );
    while (result.result === 0x80000010 || result.result === 0x80000020) {
      if (this.files.media.isAvailable(this.configuration.secondaryMediaPath)) {
        result = await this.archives.resource(
          this.archivePath(this.configuration.secondaryRoot, archiveBytes(archive)),
          name,
        );
      }
      if (result.result === 0x80000010 || result.result === 0x80000020) {
        if (!retry) return {result: 0, bytes: null};
        await this.retry(archive, name);
      }
    }
    return result;
  }

  /** 1400bd6b0 really loads/decodes and frees the bytes; its fallback differs from bd7d0. */
  async size(archive: AokanaArchiveName | null, name: Uint8Array): Promise<number> {
    const primary = await this.loose(this.configuration.primaryRoot, name);
    if (primary !== null) return primary.length;
    if (archive === null)
      return (await this.loose(this.configuration.secondaryRoot, name))?.length ?? 0;
    let result = await this.archives.resource(
      this.archivePath(this.configuration.primaryRoot, archiveBytes(archive)),
      name,
    );
    if (
      result.result === 0x80000010 &&
      this.files.media.isAvailable(this.configuration.secondaryMediaPath)
    ) {
      result = await this.archives.resource(
        this.archivePath(this.configuration.secondaryRoot, archiveBytes(archive)),
        name,
      );
    }
    return result.result < 0x80000000 ? result.result : 0;
  }

  async readModule(
    archive: Uint8Array | null,
    name: Uint8Array,
    retry = true,
  ): Promise<Uint8Array | null> {
    const result = await this.load(archive, name, retry);
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

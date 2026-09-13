import type {ByteSource} from '../../../../../core/source.js';
import {FileError, type FileSystem} from '../../../../../platform/filesystem.js';
import {AokanaNativeText} from './text.js';
import type {AokanaMountedProgramPaths} from './program-paths.js';
import type {AokanaSpecialFolders} from './special-folders.js';
import {AokanaMountedFileMetadata} from './file-metadata.js';

export function terminatedNativeBytes(bytes: Uint8Array): Uint8Array {
  const end = bytes.indexOf(0);
  if (end >= 0) return bytes.subarray(0, end + 1);
  const result = new Uint8Array(bytes.length + 1);
  result.set(bytes);
  return result;
}

/** Mounted media state consumed by 1400bc7e0; no host drives are accessed. */
export class AokanaProgramMedia {
  readonly driveTypes = new Uint32Array(26);
  readonly probeDrives = new Uint32Array(26);
  operatingSystemType = 2;
  readonly mediaPresent = new Uint8Array(26);
  readonly volumePresent = new Uint8Array(26);

  /** 1400bca90 records GetDriveType and probes every type except DRIVE_FIXED. */
  setDriveType(index: number, type: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= 26)
      throw new RangeError('Invalid Aokana drive index');
    this.driveTypes[index] = type;
    this.probeDrives[index] = Number(type >>> 0 !== 3);
  }

  isAvailable(widePath: string): boolean {
    if (widePath.startsWith('"')) widePath = widePath.slice(1);
    const letter = widePath.charCodeAt(0) | 32;
    if (letter >= 97 && letter <= 122 && widePath[1] === ':') {
      const index = letter - 97;
      if (this.probeDrives[index] !== 0 && this.operatingSystemType === 2) {
        return this.mediaPresent[index] !== 0 || this.volumePresent[index] !== 0;
      }
      return true;
    }
    return widePath.startsWith('\\\\');
  }
}

export type AokanaOpenResult =
  {source: ByteSource; error: 0; mountedPath: string} | {source: null; error: number};

/** A create/truncate output lifetime over browser atomic file commits.
 * The platform reports either a complete write or zero bytes; earlier committed writes survive failure. */
export class AokanaProgramOutputFile {
  private contents = new Uint8Array();
  private position = 0n;
  private closed = false;
  private constructor(
    private readonly files: FileSystem,
    readonly path: string,
  ) {}

  /** 14008ca80: OPEN_ALWAYS preserves bytes and starts at zero; CREATE_ALWAYS truncates. */
  static async create(
    files: FileSystem,
    path: string,
    preserveExisting = false,
  ): Promise<AokanaProgramOutputFile | null> {
    let contents = new Uint8Array();
    try {
      if (preserveExisting) {
        try {
          const source = await (files instanceof AokanaMountedFileMetadata
            ? files.openOutputContents(path)
            : files.open(path));
          contents = new Uint8Array(await source.read(0, source.size));
        } catch (error) {
          if (!(error instanceof FileError) || error.code !== 'NOT_FOUND') throw error;
        }
      }
      // The existing bytes are committed unchanged to exercise the actual write permission boundary.
      const changes = [{kind: 'write' as const, path, data: contents}];
      if (preserveExisting && files instanceof AokanaMountedFileMetadata)
        await files.commitPreservingTimes(changes);
      else await files.commit(changes);
    } catch (error) {
      if (error instanceof FileError || error instanceof DOMException) return null;
      throw error;
    }
    const output = new AokanaProgramOutputFile(files, path);
    output.contents = contents;
    return output;
  }

  /** 08CC00/08CC50 preserve a signed64 absolute cursor independently of file size. */
  size(): bigint {
    return this.closed ? 0n : BigInt(this.contents.length);
  }
  seekAbsolute(position: bigint): boolean {
    position = BigInt.asIntN(64, position);
    if (this.closed || position < 0n) return false;
    this.position = position;
    return true;
  }

  /** 14008ccb0: failure reports zero and retains the current file position. */
  async write(bytes: Uint8Array): Promise<number> {
    if (this.closed) return 0;
    if (bytes.length === 0) return 0;
    const end = this.position + BigInt(bytes.length);
    if (end > BigInt(Number.MAX_SAFE_INTEGER))
      throw new RangeError(
        'Aokana output file position exceeds the mounted byte-source numerical domain',
      );
    const contents = new Uint8Array(Math.max(this.contents.length, Number(end)));
    contents.set(this.contents);
    contents.set(bytes, Number(this.position));
    try {
      await this.files.commit([{kind: 'write', path: this.path, data: contents}]);
    } catch (error) {
      if (error instanceof FileError || error instanceof DOMException) return 0;
      throw error;
    }
    this.contents = contents;
    this.position = end;
    return bytes.length >>> 0;
  }

  /** 14008cd30: repeated close is inert. */
  close(): void {
    this.closed = true;
  }
}

/** CFileDX's title encoding boundary over the engine's ordinary filesystem primitive. */
export class AokanaProgramFiles {
  /** The composition owner shares this service with E0 and the native system-file wrappers. */
  specialFolders: AokanaSpecialFolders | null = null;
  readonly metadata: AokanaMountedFileMetadata | null;
  constructor(
    private readonly files: FileSystem,
    readonly text: AokanaNativeText,
    readonly media: AokanaProgramMedia,
    readonly paths: AokanaMountedProgramPaths | null = null,
  ) {
    this.metadata = files instanceof AokanaMountedFileMetadata ? files : null;
  }

  mountedPath(wide: string): string {
    return this.paths?.resolve(wide) ?? wide;
  }

  path(bytes: Uint8Array): string {
    return this.text.decodeAuto({bytes: terminatedNativeBytes(bytes), offset: 0});
  }

  isAvailable(bytes: Uint8Array): boolean {
    return this.media.isAvailable(this.path(bytes));
  }

  async open(bytes: Uint8Array): Promise<AokanaOpenResult> {
    return this.openWide(this.path(bytes));
  }

  async openWide(path: string): Promise<AokanaOpenResult> {
    try {
      const mountedPath = this.mountedPath(path);
      return {source: await this.files.open(mountedPath), error: 0, mountedPath};
    } catch (error) {
      if (error instanceof FileError) {
        return {source: null, error: error.code === 'READ_ONLY' ? 5 : 2};
      }
      if (error instanceof DOMException) {
        return {source: null, error: error.name === 'NotAllowedError' ? 5 : 2};
      }
      throw error;
    }
  }

  async write(path: Uint8Array, bytes: Uint8Array): Promise<number> {
    try {
      const wide = this.path(path);
      await this.files.commit([
        {kind: 'write', path: this.paths?.resolve(wide) ?? wide, data: bytes},
      ]);
      return bytes.length >>> 0;
    } catch (error) {
      if (error instanceof FileError || error instanceof DOMException) return 0;
      throw error;
    }
  }

  /** 1400695a0 retains its native wide stack capacity for both concrete write dispositions. */
  async createOutput(
    path: Uint8Array,
    preserveExisting = false,
  ): Promise<AokanaProgramOutputFile | null> {
    const wide = this.path(path);
    if (wide.length > 783)
      throw new RangeError('Aokana output file path overwrites its native wide stack buffer');
    try {
      return AokanaProgramOutputFile.create(
        this.files,
        this.paths?.resolve(wide) ?? wide,
        preserveExisting,
      );
    } catch (error) {
      if (error instanceof FileError || error instanceof DOMException) return null;
      throw error;
    }
  }

  /** ReadFile clips at EOF; ByteSource itself requires every range to be in bounds. */
  async read(source: ByteSource, offset: number, length: number): Promise<Uint8Array> {
    offset >>>= 0;
    length >>>= 0;
    if (offset >= source.size || length === 0) return new Uint8Array();
    return source.read(offset, Math.min(length, source.size - offset));
  }
}

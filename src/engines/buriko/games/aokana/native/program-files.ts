import type {ByteSource} from '../../../../../core/source.js';
import {FileError, type FileSystem} from '../../../../../platform/filesystem.js';
import {pointerView, type AokanaBpPointer} from '../bp/memory.js';
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

/** Explicit synchronous GetDriveTypeA-shaped primitive for the 26 literal roots. */
export interface AokanaDriveTypeHost {
  readDriveType(root: string): number;
}

/** A concrete selected 26-drive profile; no drive type is inferred from mounted paths. */
export class AokanaDriveTypeProfile implements AokanaDriveTypeHost {
  private readonly types: Uint32Array;
  constructor(types: ArrayLike<number>) {
    if (types.length !== 26) throw new RangeError('Aokana drive profile requires 26 entries');
    this.types = Uint32Array.from(types, (value) => value >>> 0);
  }
  readDriveType(root: string): number {
    const letter = root.charCodeAt(0);
    if (
      root.length !== 3 ||
      letter < 65 ||
      letter > 90 ||
      root[1] !== ':' ||
      root.charCodeAt(2) !== 92
    )
      throw new RangeError(
        'Aokana drive profile requires an uppercase root from A:\\ through Z:\\',
      );
    return this.types[letter - 65]!;
  }
}

/** Explicit synchronous GetDiskFreeSpaceA bytes-per-sector boundary. */
export interface AokanaDriveGeometryHost {
  /** Null is API failure; a successful selected profile supplies a positive DWORD. */
  readBytesPerSector(root: string): number | null;
}

/** A concrete selected 26-drive geometry profile; mounted contents do not imply sectors. */
export class AokanaDriveGeometryProfile implements AokanaDriveGeometryHost {
  private readonly sectors: readonly (number | null)[];
  constructor(sectors: ArrayLike<number | null>) {
    if (sectors.length !== 26)
      throw new RangeError('Aokana drive-geometry profile requires 26 entries');
    this.sectors = Array.from(sectors, (value) => {
      if (value === null) return null;
      if (!Number.isInteger(value) || value <= 0 || value > 0xffffffff)
        throw new RangeError(
          'Aokana drive-geometry values must be positive unsigned 32-bit integers',
        );
      return value >>> 0;
    });
  }
  readBytesPerSector(root: string): number | null {
    const letter = root.charCodeAt(0);
    if (
      root.length !== 3 ||
      letter < 97 ||
      letter > 122 ||
      root[1] !== ':' ||
      root.charCodeAt(2) !== 92
    )
      throw new RangeError(
        'Aokana drive-geometry profile requires a lowercase root from a:\\ through z:\\',
      );
    return this.sectors[letter - 97]!;
  }
}

/** Explicit synchronous GetDiskFreeSpaceExW-shaped platform boundary. */
export interface AokanaDiskFreeSpaceHost {
  readFreeBytesAvailable(path: string): bigint | null;
}

/** A concrete selected path profile; no browser quota or mounted size is inferred. */
export class AokanaDiskFreeSpaceProfile implements AokanaDiskFreeSpaceHost {
  private readonly values = new Map<string, bigint | null>();
  constructor(entries: Iterable<readonly [string, bigint | null]>) {
    for (const [path, value] of entries) {
      if (value !== null && (value < 0n || value > 0xffffffffffffffffn))
        throw new RangeError('Aokana disk-free-space values must be unsigned 64-bit integers');
      this.values.set(path, value);
    }
  }
  readFreeBytesAvailable(path: string): bigint | null {
    return this.values.get(path) ?? null;
  }
}

/** Mounted media state consumed by 1400bc7e0 and refreshed only through an explicit host. */
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

  /** BCA90 queries all literal roots in order and refreshes both parallel native tables. */
  refreshDriveTypes(host: AokanaDriveTypeHost): void {
    for (let index = 0; index < 26; index++)
      this.setDriveType(index, host.readDriveType(`${String.fromCharCode(65 + index)}:\\`));
  }

  /** BCA00 refreshes first, writes all 26 classifications, and returns the recognized count. */
  writeDriveClassifications(host: AokanaDriveTypeHost, output: AokanaBpPointer | null): number {
    this.refreshDriveTypes(host);
    const view = pointerView(output!, 26 * 4);
    let count = 26;
    for (let index = 0; index < 26; index++) {
      const raw = this.driveTypes[index]!;
      let classification = 0;
      if (raw === 2) classification = 2;
      else if (raw === 3) classification = 1;
      else if (raw === 4) classification = 3;
      else if (raw === 5) classification = 4;
      else if (raw === 6) classification = 5;
      else count--;
      view.setUint32(index * 4, classification, true);
    }
    return count;
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

  /** B99D0 normalizes one trailing slash and stores caller-available bytes in truncated MiB. */
  readDiskFreeMegabytes(
    host: AokanaDiskFreeSpaceHost,
    path: AokanaBpPointer,
    output: AokanaBpPointer | null,
  ): number {
    let widePath = this.text.decodeAuto(path);
    if (widePath.length !== 0 && !widePath.endsWith('\\')) widePath += '\\';
    if (!this.media.isAvailable(widePath)) return 0;
    const bytes = host.readFreeBytesAvailable(widePath);
    if (bytes === null) return 0;
    pointerView(output!, 4).setUint32(0, Number((bytes >> 20n) & 0xffffffffn), true);
    return 1;
  }

  /** B9E40 validates one drive prefix, then performs an aligned mounted-file read. */
  async readDriveFile(
    host: AokanaDriveGeometryHost,
    destination: AokanaBpPointer | null,
    outputSize: AokanaBpPointer | null,
    path: Uint8Array,
    requestedLength: number,
  ): Promise<0 | 1 | 8 | 0xffffffff> {
    const originalPath = terminatedNativeBytes(path).slice(),
      lowercasePath = originalPath.slice();
    this.text.lowercase({bytes: lowercasePath, offset: 0});
    const drive = lowercasePath[0];
    if (drive === undefined || drive < 97 || drive > 122 || lowercasePath[1] !== 58) return 8;

    const selectedSectorSize = host.readBytesPerSector(`${String.fromCharCode(drive)}:\\`);
    if (selectedSectorSize === null) return 0xffffffff;
    let roundedLength = selectedSectorSize >>> 0;
    if (roundedLength === 0)
      throw new RangeError('Aokana drive-file sector doubling cannot progress from zero');

    const opened = await this.open(originalPath);
    if (opened.source === null) return 1;
    requestedLength >>>= 0;
    if (requestedLength === 0) requestedLength = opened.source.size >>> 0;
    while (roundedLength < requestedLength) {
      const doubled = Math.imul(roundedLength, 2) >>> 0;
      if (doubled <= roundedLength)
        throw new RangeError('Aokana drive-file sector doubling overflows its DWORD');
      roundedLength = doubled;
    }

    let allocation: Uint8Array;
    try {
      allocation = new Uint8Array(roundedLength);
    } catch (error) {
      if (error instanceof RangeError) return 0xffffffff;
      throw error;
    }
    let stored: Uint8Array;
    try {
      stored = await this.read(opened.source, 0, roundedLength);
    } catch (error) {
      if (error instanceof FileError || error instanceof DOMException) return 0xffffffff;
      throw error;
    }
    allocation.set(stored);
    const finalLength = Math.min(requestedLength, stored.length) >>> 0;
    pointerView(outputSize!, 4).setUint32(0, finalLength, true);
    const output = pointerView(destination!, finalLength);
    new Uint8Array(output.buffer, output.byteOffset, output.byteLength).set(
      allocation.subarray(0, finalLength),
    );
    return 0;
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

import type {ByteSource} from '../../../../../core/source.js';
import {FileError} from '../../../../../platform/filesystem.js';
import {pointerView, type AokanaBpPointer} from '../bp/memory.js';
import {AokanaProgramFiles, type AokanaProgramOutputFile} from './program-files.js';
import {aokanaRegistryFold} from './registry-case.js';
import {textBytes} from './text.js';
import type {AokanaFileTimes} from './file-metadata.js';

/** CFileDX/ DCFile owns the actual open read or write lifetime and its signed64 cursor. */
export class AokanaNativeFile {
  private static readonly openFiles = new WeakMap<AokanaProgramFiles, Set<AokanaNativeFile>>();
  private source: ByteSource | null = null;
  private output: AokanaProgramOutputFile | null = null;
  private position = 0n;
  private openPath: string | null = null;
  private mountedPath: string | null = null;
  private writeAccess = false;
  lastError = 0; // 08CBC0 +10; only the read-open helper writes GetLastError.
  constructor(readonly files: AokanaProgramFiles) {}

  private pathname(path: AokanaBpPointer): {bytes: Uint8Array; wide: string; identity: string} {
    const bytes = textBytes(path, true),
      wide = this.files.path(bytes);
    if (wide.length > 783)
      throw new RangeError('Aokana native file path exceeds its wide stack record');
    return {bytes, wide, identity: this.pathIdentity(wide)};
  }
  private pathIdentity(wide: string): string {
    let identity = wide;
    if (this.files.paths !== null) {
      try {
        identity = aokanaRegistryFold(this.files.paths.resolveNative(wide));
      } catch (error) {
        if (!(error instanceof FileError)) throw error;
      }
    }
    return identity;
  }
  /** The shared mounted native-file namespace retains GENERIC_READ/share-read versus exclusive write. */
  private reserve(path: string, write: boolean): boolean {
    let opened = AokanaNativeFile.openFiles.get(this.files);
    if (opened === undefined) {
      opened = new Set();
      AokanaNativeFile.openFiles.set(this.files, opened);
    }
    for (const file of opened)
      if (file.openPath === path && (write || file.writeAccess)) return false;
    this.openPath = path;
    this.writeAccess = write;
    opened.add(this);
    return true;
  }
  private release(): void {
    AokanaNativeFile.openFiles.get(this.files)?.delete(this);
    this.openPath = null;
    this.mountedPath = null;
  }
  /** 0695F0 -> 08CAF0: OPEN_EXISTING and share-read; failure updates +10. */
  async openRead(path: AokanaBpPointer): Promise<0 | 1> {
    if (this.openPath !== null) return 0;
    return this.openReadWide(this.pathname(path).wide);
  }
  /** Direct08CAF0 has no CFileDX encoded-to-wide stack conversion. */
  async openReadWide(wide: string): Promise<0 | 1> {
    if (this.openPath !== null) return 0;
    if (!this.reserve(this.pathIdentity(wide), false)) {
      this.lastError = 32; // ERROR_SHARING_VIOLATION at the selected Windows file boundary.
      return 0;
    }
    const result = await this.files.openWide(wide);
    if (result.source === null) {
      this.lastError = result.error;
      this.release();
      return 0;
    }
    this.source = result.source;
    this.mountedPath = result.mountedPath;
    this.position = 0n;
    return 1;
  }
  /** 0695A0 -> 069360 -> 08CA80: only preserve=1 selects OPEN_ALWAYS. */
  async openWrite(path: AokanaBpPointer, preserve: number): Promise<0 | 1> {
    if (this.openPath !== null) return 0;
    const {bytes, identity} = this.pathname(path);
    if (!this.reserve(identity, true)) return 0;
    const output = await this.files.createOutput(bytes, (preserve | 0) === 1);
    if (output === null) {
      this.release();
      return 0;
    }
    this.output = output;
    this.mountedPath = output.path;
    this.position = 0n;
    return 1;
  }
  /** 08CC00 returns all64 bits; the script consumer deliberately uses only its low DWORD. */
  size(): bigint {
    return this.output?.size() ?? BigInt(this.source?.size ?? 0);
  }
  /** 08CC50 sets a signed64 absolute position and does not restrict it to current size. */
  seekAbsolute(position: bigint): boolean {
    position = BigInt.asIntN(64, position);
    if (position < 0n || this.openPath === null) return false;
    if (this.output !== null && !this.output.seekAbsolute(position)) return false;
    this.position = position;
    return true;
  }
  /** 08CCF0 clips at EOF and returns the actual DWORD count; host failure returns zero. */
  async read(output: AokanaBpPointer, count: number, initialized?: Uint8Array): Promise<number> {
    return (await this.readResult(output, count, initialized)).transferred;
  }
  /** Shared actual ReadFile boundary; CFileStorage also consumes the BOOL result. */
  async readResult(
    output: AokanaBpPointer,
    count: number,
    initialized?: Uint8Array,
  ): Promise<{success: boolean; transferred: number}> {
    count >>>= 0;
    const source = this.source;
    if (source === null) return {success: false, transferred: 0};
    if (this.position >= BigInt(source.size) || count === 0) return {success: true, transferred: 0};
    let bytes: Uint8Array;
    try {
      bytes = await source.read(
        Number(this.position),
        Math.min(count, source.size - Number(this.position)),
      );
    } catch (error) {
      if (error instanceof FileError || error instanceof DOMException)
        return {success: false, transferred: 0};
      throw error;
    }
    const destination = pointerView(output, bytes.length);
    if (initialized !== undefined && output.offset + bytes.length > initialized.length)
      throw new RangeError('Aokana native file read exceeds destination initialization mask');
    new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength).set(bytes);
    initialized?.fill(1, output.offset, output.offset + bytes.length);
    this.position += BigInt(bytes.length);
    return {success: true, transferred: bytes.length >>> 0};
  }
  /** 08CCB0 observes the supplied transfer bytes at call time, after the worker dequeues its job. */
  async write(source: AokanaBpPointer, count: number): Promise<number> {
    count >>>= 0;
    if (this.output === null || count === 0) return 0;
    const input = pointerView(source, count);
    const transferred = await this.output.write(
      new Uint8Array(input.buffer, input.byteOffset, input.byteLength),
    );
    this.position += BigInt(transferred);
    return transferred;
  }
  /** 08CA60 reads three FILETIMEs from the actual mounted file handle's metadata owner. */
  async getTimes(): Promise<AokanaFileTimes | null> {
    if (this.mountedPath === null || this.files.metadata === null) return null;
    try {
      return await this.files.metadata.getTimes(this.mountedPath);
    } catch (error) {
      if (error instanceof FileError || error instanceof DOMException) return null;
      throw error;
    }
  }
  /** 08CA60 with only last-write output: unrelated FILETIMEs need not be known. */
  async getWriteTime(): Promise<bigint | null> {
    if (this.mountedPath === null || this.files.metadata === null) return null;
    try {
      return (await this.files.metadata.metadata(this.mountedPath)).writeTime;
    } catch (error) {
      if (error instanceof FileError || error instanceof DOMException) return null;
      throw error;
    }
  }
  /** 08CA40 requires the existing write handle; no separate path is reopened for metadata. */
  async setTimes(times: AokanaFileTimes): Promise<0 | 1> {
    if (this.output === null || this.mountedPath === null || this.files.metadata === null) return 0;
    try {
      await this.files.metadata.setTimes(this.mountedPath, times);
    } catch (error) {
      if (error instanceof FileError || error instanceof DOMException) return 0;
      throw error;
    }
    return 1;
  }
  /** 08CD30, also called by the concrete base/derived destructors. */
  close(): void {
    this.output?.close();
    this.output = null;
    this.source = null;
    this.release();
  }
  dispose(): void {
    this.close();
  }
}

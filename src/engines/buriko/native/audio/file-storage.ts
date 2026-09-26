import type {BurikoBpPointer} from '../../bp/memory.js';
import {BurikoNativeFile} from '../native-file.js';
import type {BurikoProgramFiles} from '../program-files.js';
import type {BurikoLiveAudioStorage} from './live-storage.js';

/** 115B80 CFileStorage: owns a real read handle and a separate DWORD cursor. */
export class BurikoFileStorage implements BurikoLiveAudioStorage {
  private readonly file: BurikoNativeFile;
  private opened = false;
  private disposed = false;
  private positionValue: number | undefined;
  private flagsValue: number | undefined;
  constructor(files: BurikoProgramFiles) {
    this.file = new BurikoNativeFile(files);
  }
  private check(): void {
    if (this.disposed) throw new Error('Buriko file storage accesses released owner');
  }
  get flags(): number {
    this.check();
    if (this.flagsValue === undefined) throw new Error('Buriko file storage reads unwritten flags');
    return this.flagsValue;
  }
  get position(): number {
    this.check();
    if (this.positionValue === undefined)
      throw new Error('Buriko file storage reads unwritten cursor');
    return this.positionValue;
  }
  /** 115980/1159F0: GetFileSize low DWORD, including invalid-handle failure. */
  get size(): number {
    this.check();
    return this.opened ? Number(BigInt.asUintN(32, this.file.size())) : 0xffffffff;
  }
  /** 1159A0. */
  get remaining(): number {
    return (this.size - this.position) >>> 0;
  }
  /** 115C00: direct wide read/share-read open; cursor/flags publish even on failure. */
  async open(path: string): Promise<boolean> {
    this.check();
    if (this.opened) return false;
    const opened = await this.file.openReadWide(path);
    this.positionValue = 0;
    this.opened = opened !== 0;
    this.flagsValue = 1;
    return this.opened;
  }
  /** 115A20: unsigned clamp, then signed LONG SetFilePointer without a high pointer. */
  seek(position: number, _actor?: object): number {
    this.check();
    const target = Math.min(position >>> 0, this.size);
    this.positionValue = this.file.seekAbsolute(BigInt(target | 0)) ? target : 0xffffffff;
    return this.positionValue;
  }
  /** 1162E0 →115AB0: preserve real destination writes and ReadFile failure=-1. */
  async readInto(
    destination: BurikoBpPointer,
    count: number,
    _actor: object,
    initialized?: Uint8Array,
  ): Promise<number> {
    this.check();
    if ((this.flags & 1) === 0) return -1;
    const result = await this.file.readResult(destination, count, initialized);
    if (!result.success) return -1;
    this.positionValue = (this.position + result.transferred) >>> 0;
    return result.transferred;
  }
  /** 115B00 leaves cursor and flags intact. */
  close(): void {
    this.check();
    if (this.opened) this.file.close();
    this.opened = false;
  }
  /** 115B30 ownership adaptation: release the actual handle once. */
  dispose(): void {
    this.close();
    this.disposed = true;
  }
}

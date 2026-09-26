import type {BurikoBpPointer} from '../../bp/memory.js';
import {BurikoNativeFile} from '../native-file.js';
import type {BurikoProgramFiles} from '../program-files.js';
import type {BurikoLiveAudioStorage} from './live-storage.js';

const signature = new TextEncoder().encode('PackFile    ');
const lower = (byte: number): number => (byte >= 65 && byte <= 90 ? byte + 32 : byte);

/** 471820: an embedded, load-once PackFile index. This is not the later DCArchive cache. */
class Legacy169PackFile {
  private count = 0;
  private payloadBase = 0;
  private index = new Uint8Array();
  private initialized = new Uint8Array();
  constructor(
    readonly files: BurikoProgramFiles,
    readonly path: string,
  ) {}

  private byte(offset: number): number {
    if (offset >= this.index.length)
      throw new RangeError('Buriko 1.69 audio index reads beyond its native allocation');
    if (this.initialized[offset] !== 1)
      throw new Error('Buriko 1.69 audio index reads unwritten allocation bytes');
    return this.index[offset]!;
  }
  private dword(offset: number): number {
    return (
      (this.byte(offset) |
        (this.byte(offset + 1) << 8) |
        (this.byte(offset + 2) << 16) |
        (this.byte(offset + 3) << 24)) >>>
      0
    );
  }
  async open(): Promise<boolean> {
    const file = new BurikoNativeFile(this.files);
    if (!(await file.openReadWide(this.path))) return false;
    try {
      const header = new Uint8Array(16);
      if (
        (await file.read({bytes: header, offset: 0}, 16)) !== 16 ||
        signature.some((byte, offset) => header[offset] !== byte)
      )
        return false;
      this.count = new DataView(header.buffer).getInt32(12, true);
      const byteLength = (this.count * 32) >>> 0;
      this.payloadBase = (byteLength + 16) >>> 0;
      this.index = new Uint8Array(byteLength);
      this.initialized = new Uint8Array(byteLength);
      // The native reader ignores this count. Unwritten bytes remain indeterminate.
      await file.read({bytes: this.index, offset: 0}, byteLength, this.initialized);
      for (let entry = 0; entry < this.count; entry++)
        for (let offset = entry * 32; this.byte(offset) !== 0; offset++)
          this.index[offset] = lower(this.byte(offset));
      return true;
    } finally {
      file.close();
    }
  }
  /** 4719f0/471c40/471aa0 use the CRT C-locale byte fold and first matching record. */
  find(name: Uint8Array): number | undefined {
    if (name.length > 16)
      throw new RangeError('Buriko 1.69 audio member exceeds its native 16-byte query stack');
    for (let entry = 0; entry < this.count; entry++) {
      const base = entry * 32;
      for (let offset = 0; offset < name.length; offset++) {
        const byte = this.byte(base + offset);
        if (byte !== lower(name[offset]!)) break;
        if (byte === 0) return base;
      }
    }
    return undefined;
  }
  size(entry: number): number {
    return this.dword(entry + 20);
  }

  async read(
    destination: BurikoBpPointer,
    name: Uint8Array,
    offset: number,
    count: number,
    initialized?: Uint8Array,
  ): Promise<number> {
    const entry = this.find(name);
    if (entry === undefined) return 0x80000020;
    const file = new BurikoNativeFile(this.files);
    if (!(await file.openReadWide(this.path))) return 0x80000010;
    try {
      const size = this.size(entry);
      if (count === 0) count = size;
      if (size < count) return 0x80000040;
      if (size < (offset + count) >>> 0) return 0x80000030;
      // 471dc0 passes a signed LONG and null high-distance pointer. Its failure is ignored.
      file.seekAbsolute(BigInt((this.dword(entry + 16) + this.payloadBase + offset) | 0));
      return await file.read(destination, count, initialized);
    } finally {
      file.close();
    }
  }
}

/** 470d60/470ea0/470f50: every legacy storage owns its indexes and independent cursor. */
export class BurikoLegacy169ArchiveFileStorage implements BurikoLiveAudioStorage {
  private readonly archives = new Map<string, Legacy169PackFile>();
  private archive: Legacy169PackFile | undefined;
  private name: Uint8Array = new Uint8Array();
  private positionValue: number | undefined;
  private sizeValue = 0;
  private disposed = false;
  readonly flags = 1;
  constructor(readonly files: BurikoProgramFiles) {}
  get size(): number {
    return this.sizeValue;
  }
  get position(): number {
    if (this.positionValue === undefined)
      throw new Error('Buriko 1.69 archive storage reads unwritten cursor');
    return this.positionValue;
  }
  private check(): void {
    if (this.disposed) throw new Error('Buriko 1.69 archive storage accesses released owner');
  }
  async open(path: string, member: string): Promise<boolean> {
    this.check();
    const pathBytes = this.files.text.encodeWide(path, 0),
      name = this.files.text.encodeWide(member, 0);
    path = this.files.text.decodeCp932(pathBytes.subarray(0, -1));
    if (!(await this.files.hasPathWide(path))) return false;
    let archive = this.archives.get(path);
    if (archive === undefined) {
      archive = new Legacy169PackFile(this.files, path);
      if (!(await archive.open())) return false;
      // 471770 compares the original narrow path exactly, without case folding or mtime checks.
      if (pathBytes.length > 260)
        throw new RangeError('Buriko 1.69 audio archive path exceeds its native 260-byte record');
      this.archives.set(path, archive);
    }
    const entry = archive.find(name);
    if (entry === undefined) return false;
    this.archive = archive;
    this.name = name;
    this.positionValue = 0;
    this.sizeValue = archive.size(entry);
    return true;
  }
  seek(position: number): number {
    this.check();
    return (this.positionValue = Math.min(position >>> 0, this.sizeValue));
  }
  async readInto(
    destination: BurikoBpPointer,
    count: number,
    _actor: object,
    initialized?: Uint8Array,
  ): Promise<number> {
    this.check();
    const position = this.position;
    count >>>= 0;
    if (this.sizeValue < (position + count) >>> 0) count = (this.sizeValue - position) >>> 0;
    if (count === 0) return 0;
    if (this.archive === undefined)
      throw new Error('Buriko 1.69 archive storage reads unwritten archive');
    const result = await this.archive.read(destination, this.name, position, count, initialized);
    // Native bug: the high-bit error values advance the DWORD cursor too.
    this.positionValue = (position + result) >>> 0;
    return result;
  }
  dispose(): void {
    this.check();
    this.archives.clear();
    this.archive = undefined;
    this.disposed = true;
  }
}

import {markIndeterminateMemory} from '../../../../core/indeterminate-memory.js';
import {pointerView, type BurikoBpPointer} from '../../bp/memory.js';
import {BurikoNativeFile} from '../native-file.js';
import type {BurikoProgramFiles} from '../program-files.js';
import {textByte, writeText} from '../text.js';
import type {BurikoLiveAudioStorage} from './live-storage.js';

const packSignature = new TextEncoder().encode('PackFile    ');
const arcSignature = new TextEncoder().encode('BURIKO ARC20');

/** 004c9100: a load-once PackFile/ARC20 index, separate from the later DCArchive cache. */
class Buriko1665Archive {
  private count = 0;
  private payloadBase = 0;
  private index: Uint8Array = new Uint8Array();
  constructor(
    readonly files: BurikoProgramFiles,
    readonly path: string,
  ) {}

  private allocation(count: number, width: number): Uint8Array {
    const size = count * width;
    // The native unsigned allocation product saturates to UINT_MAX on overflow.
    if (size > 0xffffffff)
      throw new RangeError('Buriko 1.665 audio index allocation overflows its native size');
    return new Uint8Array(size);
  }
  private async readIndex(file: BurikoNativeFile, bytes: Uint8Array): Promise<void> {
    const written = await file.read({bytes, offset: 0}, bytes.length);
    // 004c9100 ignores short index transfers; retain the untouched allocation tail.
    markIndeterminateMemory(
      bytes,
      written,
      bytes.length - written,
      'Buriko 1.665 audio index reads unwritten allocation bytes',
    );
  }
  async open(): Promise<boolean> {
    const file = new BurikoNativeFile(this.files);
    if (!(await file.openReadWide(this.path))) return false;
    try {
      const header = new Uint8Array(16);
      if ((await file.read({bytes: header, offset: 0}, 16)) !== 16) return false;
      const pack = packSignature.every((byte, offset) => header[offset] === byte);
      if (!pack && !arcSignature.every((byte, offset) => header[offset] === byte)) return false;
      this.count = new DataView(header.buffer).getUint32(12, true);
      this.payloadBase = (Math.imul(this.count, pack ? 32 : 128) + 16) >>> 0;
      this.index = this.allocation(this.count, 128);
      if (pack) {
        const packed = this.allocation(this.count, 32);
        await this.readIndex(file, packed);
        for (let entry = 0; entry < (this.count | 0); entry++) {
          const source = {bytes: packed, offset: entry * 32},
            destination = {bytes: this.index, offset: entry * 128};
          // Each expanded record is zeroed before the name and metadata are copied.
          this.index.fill(0, destination.offset, destination.offset + 128);
          writeText(destination, this.files.text.convertEncoding(source, 1));
          this.files.text.lowercase(destination);
          const input = pointerView(source, 24),
            output = pointerView(destination, 104);
          output.setUint32(96, input.getUint32(16, true), true);
          output.setUint32(100, input.getUint32(20, true), true);
        }
      } else {
        await this.readIndex(file, this.index);
        for (let entry = 0; entry < (this.count | 0); entry++) {
          const name = {bytes: this.index, offset: entry * 128};
          if (this.files.text.detectEncoding(this.index, name.offset) === 0)
            writeText(name, this.files.text.convertEncoding(name, 1));
          this.files.text.lowercase(name);
        }
      }
      return true;
    } finally {
      file.close();
    }
  }
  /** 004c8f20/004c9010/004c94f0 use the first matching 128-byte record. */
  find(name: Uint8Array): number | undefined {
    for (let entry = 0; entry < (this.count | 0); entry++) {
      const base = entry * 128;
      for (let offset = 0; offset < name.length; offset++) {
        const byte = textByte(this.index, base + offset);
        if (byte !== name[offset]) break;
        if (byte === 0) return base;
      }
    }
    return undefined;
  }
  size(entry: number): number {
    return pointerView({bytes: this.index, offset: entry}, 104).getUint32(100, true);
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
      const memberOffset = pointerView({bytes: this.index, offset: entry}, 100).getUint32(96, true);
      // 00432b70 uses a signed LONG without a high-distance pointer; its failure is ignored.
      file.seekAbsolute(BigInt((memberOffset + this.payloadBase + offset) | 0));
      return await file.read(destination, count, initialized);
    } finally {
      file.close();
    }
  }
}

/** 004c8500/004c86e0: every storage embeds its own path chain and independent cursor. */
export class Buriko1665ArchiveFileStorage implements BurikoLiveAudioStorage {
  private readonly archives = new Map<string, Buriko1665Archive>();
  private archive: Buriko1665Archive | undefined;
  private name: Uint8Array = new Uint8Array();
  private positionValue: number | undefined;
  private sizeValue = 0;
  private disposed = false;
  readonly flags = 1;
  constructor(readonly files: BurikoProgramFiles) {}
  private check(): void {
    if (this.disposed) throw new Error('Buriko 1.665 archive storage accesses released owner');
  }
  get size(): number {
    this.check();
    return this.sizeValue;
  }
  get position(): number {
    this.check();
    if (this.positionValue === undefined)
      throw new Error('Buriko 1.665 archive storage reads unwritten cursor');
    return this.positionValue;
  }
  async open(path: string, member: string): Promise<boolean> {
    this.check();
    if (!(await this.files.hasPathWide(path))) return false;
    const pathBytes = this.files.text.encodeWide(path, 1),
      name = this.files.text.encodeWide(member, 1);
    if (pathBytes.length > 780 || name.length > 96)
      throw new RangeError('Buriko 1.665 audio name exceeds its native stack record');
    // 004c9690 compares lowercased UTF-8 paths and never observes a file timestamp.
    this.files.text.lowercase({bytes: pathBytes, offset: 0});
    this.files.text.lowercase({bytes: name, offset: 0});
    const lowerPath = this.files.text.decodeBytes(pathBytes.subarray(0, -1), 1);
    let archive = this.archives.get(lowerPath);
    if (archive === undefined) {
      archive = new Buriko1665Archive(this.files, lowerPath);
      if (!(await archive.open())) return false;
      this.archives.set(lowerPath, archive);
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
      throw new Error('Buriko 1.665 archive storage reads unwritten archive');
    const result = await this.archive.read(destination, this.name, position, count, initialized);
    // 004c869a adds all returned DWORDs, including high-bit errors, to the cursor.
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

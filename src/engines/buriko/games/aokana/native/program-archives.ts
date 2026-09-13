import {signature} from '../../../../../formats/buriko/binary.js';
import {AokanaProgramFiles, terminatedNativeBytes} from './program-files.js';
import {AokanaUndefinedResourceRead, decodeAokanaResource} from './resource-decode.js';
import {textBytes, textLength, writeText} from './text.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaDistributedProcessing} from './distributed-processing.js';

interface ArchiveNode {
  initialized: boolean;
  path: Uint8Array;
  count: number;
  payloadBase: number;
  index: Uint8Array;
  next: ArchiveNode | null;
}
function node(): ArchiveNode {
  return {initialized: false, path: Uint8Array.of(0), count: 0, payloadBase: 0, index: new Uint8Array(), next: null};
}
function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export interface AokanaArchiveResource {
  /** Actual byte count on success; native 0x800000xx on failure. */
  readonly result: number;
  readonly bytes: Uint8Array | null;
}

/** Native linked CArchive cache. Raw mutable 128-byte records preserve name conversion writes. */
export class AokanaProgramArchives {
  private root = node();
  private pending: Promise<void> = Promise.resolve();
  constructor(readonly files: AokanaProgramFiles, readonly errors: AokanaEngineErrors, readonly mainProcessing: AokanaDistributedProcessing) {}

  clear(): void {
    this.root = node();
  }

  private normalize(bytes: Uint8Array): Uint8Array {
    const result = this.files.text.convertEncoding({bytes: terminatedNativeBytes(bytes), offset: 0}, 1);
    if (result.length > 784) throw new RangeError('Aokana archive path exceeds native scratch storage');
    this.files.text.lowercase({bytes: result, offset: 0});
    return result;
  }

  private async openIndex(target: ArchiveNode, path: Uint8Array): Promise<boolean> {
    const opened = await this.files.open(path);
    if (opened.source === null) return false;
    const header = await this.files.read(opened.source, 0, 16);
    if (header.length !== 16) return false;
    const packed = signature(header, 'PackFile    ');
    if (!packed && !signature(header, 'BURIKO ARC20')) return false;
    // Native stores this before allocating/reading its index.
    target.path = path.slice();
    target.count = new DataView(header.buffer, header.byteOffset, 16).getUint32(12, true);
    const recordSize = packed ? 32 : 128;
    const storedSize = Math.imul(target.count, recordSize) >>> 0;
    target.payloadBase = (storedSize + 16) >>> 0;
    target.index = new Uint8Array(target.count * 128);
    const stored = await this.files.read(opened.source, 16, storedSize);
    if (stored.length !== target.count * recordSize) {
      throw new AokanaUndefinedResourceRead('Aokana archive index includes unwritten allocation bytes');
    }
    if (!packed) target.index.set(stored);
    const source = new DataView(stored.buffer, stored.byteOffset, stored.byteLength);
    const records = new DataView(target.index.buffer);
    for (let index = 0; index < target.count; index++) {
      const offset = index * 128;
      const destination = {bytes: target.index, offset};
      if (packed) {
        // Each destination record is cleared immediately before converting that record.
        target.index.fill(0, offset, offset + 128);
        writeText(destination, this.files.text.convertEncoding({bytes: stored, offset: index * 32}, 1));
        this.files.text.lowercase(destination);
        records.setUint32(offset + 96, source.getUint32(index * 32 + 16, true), true);
        records.setUint32(offset + 100, source.getUint32(index * 32 + 20, true), true);
      } else {
        if (this.files.text.detectEncoding(target.index, offset) === 0) {
          const original = textBytes(destination, true).slice();
          if (original.length > 96) throw new RangeError('Aokana ARC20 name overflows native conversion scratch');
          writeText(destination, this.files.text.convertEncoding({bytes: original, offset: 0}, 1));
        }
        this.files.text.lowercase(destination);
      }
    }
    target.initialized = true;
    return true;
  }

  private async archive(pathBytes: Uint8Array): Promise<ArchiveNode | null> {
    const previous = this.pending;
    let release!: () => void;
    this.pending = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await this.findOrOpenArchive(pathBytes);
    } finally {
      release();
    }
  }

  private async findOrOpenArchive(pathBytes: Uint8Array): Promise<ArchiveNode | null> {
    const path = this.normalize(pathBytes);
    let current = this.root;
    for (;;) {
      const same = equal(current.path, path);
      if (current.initialized) {
        if (same) return current;
      } else if (same || current.path.length === 1) {
        if (await this.openIndex(current, path)) return current;
      }
      // Failed unopened nodes cannot grow a successor (039390).
      if (!current.initialized) return null;
      current.next ??= node();
      current = current.next;
    }
  }

  private find(archive: ArchiveNode, name: Uint8Array): number | null {
    const query = this.normalize(name);
    for (let index = 0; index < archive.count; index++) {
      const offset = index * 128;
      if (equal(textBytes({bytes: archive.index, offset}, true), query)) return offset;
    }
    return null;
  }

  async size(path: Uint8Array, name: Uint8Array): Promise<number> {
    const archive = await this.archive(path);
    if (archive === null) return 0x80000010;
    const record = this.find(archive, name);
    return record === null ? 0x80000020 : new DataView(archive.index.buffer).getUint32(record + 100, true);
  }

  /** Native metadata query 038a00 returns the first matching entry's untouched qword at +104. */
  async metadata(path: Uint8Array, name: Uint8Array): Promise<bigint | null> {
    const archive = await this.archive(path);
    if (archive === null) return null;
    const record = this.find(archive, name);
    return record === null ? null : new DataView(archive.index.buffer).getBigUint64(record + 104, true);
  }

  async read(path: Uint8Array, name: Uint8Array, offset = 0, length = 0): Promise<AokanaArchiveResource> {
    const archive = await this.archive(path);
    if (archive === null) return {result: 0x80000010, bytes: null};
    const record = this.find(archive, name);
    if (record === null) return {result: 0x80000020, bytes: null};
    // The cached index survives replacement of the mounted archive, but the file is reopened.
    let attempts = 4000;
    let opened = await this.files.open(archive.path);
    while (opened.source === null && opened.error === 5 && attempts !== 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      attempts--;
      opened = await this.files.open(archive.path);
    }
    if (opened.source === null || attempts === 0) return {result: 0x80000010, bytes: null};
    const data = new DataView(archive.index.buffer);
    const size = data.getUint32(record + 100, true);
    offset >>>= 0;
    length >>>= 0;
    if (length === 0) length = (size - offset) >>> 0;
    if (size < length) return {result: 0x80000040, bytes: null};
    if (size < (offset + length) >>> 0) return {result: 0x80000030, bytes: null};
    const position = (archive.payloadBase + data.getUint32(record + 96, true) + offset) >>> 0;
    const bytes = await this.files.read(opened.source, position, length);
    return {result: bytes.length, bytes};
  }

  /** 1400bbee0 maps cache/read/decode statuses; callers receive the native high-bit result. */
  async resource(path: Uint8Array, name: Uint8Array, offset = 0, length = 0): Promise<AokanaArchiveResource> {
    if (textLength({bytes: terminatedNativeBytes(name), offset: 0}) > 95) {
      return this.errors.fatal(this.files.text.encodeWide(`指定されたファイル名 [ ${this.files.path(name)} ] は95文字を超えています`, 1));
    }
    const size = await this.size(path, name);
    if (size > 0x7fffffff) return {result: 0x80000020, bytes: null};
    if (size > 0x4000000) return {result: 0x80000060, bytes: null};
    const stored = await this.read(path, name, 0, size);
    if (stored.result !== size || stored.bytes === null) return {result: 0x80000050, bytes: null};
    const decoded = await decodeAokanaResource(stored.bytes, this.mainProcessing, offset, length);
    const mapped = {0: 0, 2: 0x80000030, 3: 0x80000040, 5: 0x80000050, 6: 0x80000060}[decoded.status];
    return {result: decoded.status === 0 ? decoded.bytes!.length : mapped, bytes: decoded.bytes};
  }
}

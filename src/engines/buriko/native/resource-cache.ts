import {BurikoNativeText} from './text.js';
import {terminatedNativeBytes} from './program-files.js';
import {burikoCrtWideLower} from './crt-case.js';
import type {BurikoBpPointer} from '../bp/memory.js';
import {codecView, type BurikoCodecPointer} from './codec-storage.js';

interface CachedResource {
  readonly archive: string | null;
  readonly name: string | null;
  readonly bytes: Uint8Array;
}

/** Optional DCCache at 1D27B8. Its wide CRT keys are independent of bitmap preload keys. */
export class BurikoResourceCache {
  private entries: CachedResource[] = [];
  private limit = 0;
  private total = 0;
  constructor(readonly text: BurikoNativeText) {}

  get enabled(): boolean {
    return this.limit !== 0;
  }
  get capacity(): number {
    return this.limit;
  }
  get bytesUsed(): number {
    return this.total;
  }

  /** 07B220 destroys the old cache even when its requested size is unchanged. */
  configure(capacity: number): void {
    this.entries = [];
    this.total = 0;
    this.limit = capacity >>> 0;
  }

  private key(bytes: Uint8Array | null): string | null {
    return bytes === null
      ? null
      : burikoCrtWideLower(this.text.decodeAuto({bytes: terminatedNativeBytes(bytes), offset: 0}));
  }

  /** 08B260 promotes the first matching entry even for a size-only query. */
  private find(archive: Uint8Array | null, name: Uint8Array | null): CachedResource | null {
    if (!this.enabled) return null;
    const archiveKey = this.key(archive),
      nameKey = this.key(name);
    const index = this.entries.findIndex(
      (entry) => entry.archive === archiveKey && entry.name === nameKey,
    );
    if (index < 0) return null;
    const [entry] = this.entries.splice(index, 1);
    this.entries.unshift(entry!);
    return entry!;
  }

  size(archive: Uint8Array | null, name: Uint8Array | null): number | null {
    return this.find(archive, name)?.bytes.length ?? null;
  }

  /** 07B270 / 08B530's size query and copy both use the same actual cache. */
  read(archive: Uint8Array | null, name: Uint8Array | null): Uint8Array | null {
    const entry = this.find(archive, name);
    if (entry === null) return null;
    return this.find(archive, name)!.bytes.slice();
  }

  /** 07B2B0 / 08B5D0 keep duplicate keys and evict oldest entries to the DWORD budget. */
  insert(archive: Uint8Array | null, name: Uint8Array | null, bytes: Uint8Array): 0 | 1 {
    const size = bytes.length >>> 0;
    if (!this.enabled || size === 0 || size > this.limit >>> 1) return 0;
    return this.insertPointer(
      archive === null ? null : {bytes: terminatedNativeBytes(archive), offset: 0},
      name === null ? null : {bytes: terminatedNativeBytes(name), offset: 0},
      {bytes, offset: 0},
      bytes.length,
    );
  }

  /** Native pointer/count entry gates capacity before touching names or source bytes. */
  insertPointer(
    archive: BurikoBpPointer | null,
    name: BurikoBpPointer | null,
    source: BurikoCodecPointer | null,
    size: number,
  ): 0 | 1 {
    size >>>= 0;
    if (!this.enabled || size === 0 || size > this.limit >>> 1) return 0;
    const archiveKey = archive === null ? null : burikoCrtWideLower(this.text.decodeAuto(archive)),
      nameKey = name === null ? null : burikoCrtWideLower(this.text.decodeAuto(name));
    codecView(source, 0, size);
    const entry = {
      archive: archiveKey,
      name: nameKey,
      bytes: source!.bytes.slice(source!.offset, source!.offset + size),
    };
    while (this.limit < (this.total + size) >>> 0) {
      const removed = this.entries.pop();
      if (removed === undefined)
        throw new Error('Buriko resource cache budget has no removable record');
      this.total = (this.total - removed.bytes.length) >>> 0;
    }
    this.entries.unshift(entry);
    this.total = (this.total + size) >>> 0;
    return 1;
  }
}

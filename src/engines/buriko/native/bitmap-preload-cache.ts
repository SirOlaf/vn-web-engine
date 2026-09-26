import {BurikoNativeText} from './text.js';
import {terminatedNativeBytes} from './program-files.js';
import {codecView, type BurikoCodecPointer} from './codec-storage.js';

interface PreloadedBitmap {
  readonly archive: Uint8Array | null;
  readonly name: Uint8Array;
  readonly bytes: Uint8Array;
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** DCPrlddDtMngr at 27C780: newest first, byte-string keys, and explicit consume on copy. */
export class BurikoBitmapPreloadCache {
  private readonly entries: PreloadedBitmap[] = [];
  constructor(readonly text: BurikoNativeText) {}

  private key(bytes: Uint8Array): Uint8Array {
    const result = terminatedNativeBytes(bytes).slice();
    if (result.length > 784)
      throw new RangeError('Buriko preload name exceeds native lookup scratch');
    this.text.lowercase({bytes: result, offset: 0});
    return result;
  }

  /** 09AD20 distinguishes a stored null archive from a stored empty string. */
  private find(archive: Uint8Array | null, name: Uint8Array): number {
    const archiveKey = archive === null ? Uint8Array.of(0) : this.key(archive);
    const nameKey = this.key(name);
    return this.entries.findIndex(
      (entry) =>
        (entry.archive === null ? archive === null : equal(entry.archive, archiveKey)) &&
        equal(entry.name, nameKey),
    );
  }

  /** 09AE50's null output-pointer query never consumes an entry. */
  size(archive: Uint8Array | null, name: Uint8Array): number | null {
    const index = this.find(archive, name);
    return index < 0 ? null : this.entries[index]!.bytes.length;
  }

  /** 09AE50 copies the complete payload before optional 09ACA0 removal. */
  read(archive: Uint8Array | null, name: Uint8Array, consume = 0): Uint8Array | null {
    const index = this.find(archive, name);
    if (index < 0) return null;
    const bytes = this.entries[index]!.bytes.slice();
    if (consume !== 0) this.remove(archive, name);
    return bytes;
  }

  /** 09AF20 retains the old payload on duplicate names and prepends only new records. */
  insert(archive: Uint8Array | null, name: Uint8Array, bytes: Uint8Array): 0 | 1 {
    return this.insertPointer(archive, name, {bytes, offset: 0}, bytes.length);
  }

  /** Duplicate lookup precedes all payload consumption, including validity checks. */
  insertPointer(
    archive: Uint8Array | null,
    name: Uint8Array,
    source: BurikoCodecPointer | null,
    count: number,
  ): 0 | 1 {
    if (this.find(archive, name) >= 0) return 0;
    const archiveKey = archive === null ? null : this.key(archive),
      nameKey = this.key(name);
    count >>>= 0;
    if (count !== 0) codecView(source, 0, count);
    this.entries.unshift({
      archive: archiveKey,
      name: nameKey,
      bytes:
        count === 0
          ? new Uint8Array(0)
          : source!.bytes.slice(source!.offset, source!.offset + count),
    });
    return 1;
  }

  /** 09ACA0 removes the first matching record without changing later entries. */
  remove(archive: Uint8Array | null, name: Uint8Array): 0 | 1 {
    const index = this.find(archive, name);
    if (index < 0) return 0;
    this.entries.splice(index, 1);
    return 1;
  }

  /** 09AE10 / 0375D0 clear the same shared cache. */
  clear(): void {
    this.entries.length = 0;
  }
}

import type {BurikoBpPointer} from '../../bp/memory.js';
import type {BurikoLiveAudioStorage} from './live-storage.js';

/**116190 fixed CMemoryStorage; no resize operation is modeled. */
export class BurikoMemoryAudioStorage implements BurikoLiveAudioStorage {
  readonly bytes: Uint8Array;
  readonly initialized: Uint8Array;
  flags = 0;
  position = 0;
  private disposed = false;
  constructor(readonly size: number) {
    this.size = size >>> 0;
    this.bytes = new Uint8Array(this.size);
    this.initialized = new Uint8Array(this.size);
  }
  private live(): void {
    if (this.disposed) throw new Error('Buriko memory audio storage has been disposed');
  }
  private bounds(pointer: BurikoBpPointer, count: number): void {
    if (
      !Number.isSafeInteger(pointer.offset) ||
      pointer.offset < 0 ||
      pointer.offset + count > pointer.bytes.length
    )
      throw new RangeError('Buriko memory audio copy crosses actual pointer backing');
  }
  write(source: BurikoBpPointer, count: number, mask?: Uint8Array): number {
    this.live();
    if ((this.flags & 2) === 0 || this.position >= this.size) return 0xffffffff;
    const length = Math.min(count >>> 0, this.size - this.position);
    this.bounds(source, length);
    if (mask !== undefined && source.offset + length > mask.length)
      throw new RangeError('Buriko memory audio source mask is shorter than backing');
    const defined = mask?.slice(source.offset, source.offset + length);
    this.bytes.set(source.bytes.slice(source.offset, source.offset + length), this.position);
    if (defined === undefined) this.initialized.fill(1, this.position, this.position + length);
    else this.initialized.set(defined, this.position);
    this.position += length;
    return length;
  }
  async readInto(
    destination: BurikoBpPointer,
    count: number,
    _actor: object,
    mask?: Uint8Array,
  ): Promise<number> {
    this.live();
    if ((this.flags & 1) === 0 || this.position >= this.size) return 0xffffffff;
    const length = Math.min(count >>> 0, this.size - this.position);
    this.bounds(destination, length);
    if (mask !== undefined && destination.offset + length > mask.length)
      throw new RangeError('Buriko memory audio destination mask is shorter than backing');
    const bytes = this.bytes.slice(this.position, this.position + length),
      defined = this.initialized.slice(this.position, this.position + length);
    destination.bytes.set(bytes, destination.offset);
    if (mask !== undefined) mask.set(defined, destination.offset);
    else if (defined.includes(0))
      throw new Error('Buriko memory audio read needs initialized-byte ownership');
    this.position += length;
    return length;
  }
  seek(position: number): number {
    this.live();
    position >>>= 0;
    if (position <= this.size) this.position = position;
    return 0;
  }
  dispose(): void {
    this.disposed = true;
  }
}

import {checkRange} from './binary.js';
import type {ByteSource} from './source.js';
/** Sequential bounded read-ahead, also useful to other packetized media formats. */
export class BufferedSource implements ByteSource {
  readonly size: number;
  private bytes = new Uint8Array();
  private start = 0;
  constructor(
    readonly source: ByteSource,
    readonly capacity = 1024 * 1024,
  ) {
    this.size = source.size;
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    checkRange(this.size, offset, length);
    if (offset < this.start || offset + length > this.start + this.bytes.length) {
      this.start = offset;
      this.bytes = (
        await this.source.read(
          offset,
          Math.min(this.size - offset, Math.max(length, this.capacity)),
        )
      ).slice();
    }
    return this.bytes.subarray(offset - this.start, offset - this.start + length);
  }
}

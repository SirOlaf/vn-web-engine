import {checkRange} from './binary.js';
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}
export class BlobSource implements ByteSource {
  readonly size: number;
  constructor(readonly blob: Blob) {
    this.size = blob.size;
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    checkRange(this.size, offset, length);
    return new Uint8Array(await this.blob.slice(offset, offset + length).arrayBuffer());
  }
}
export class HttpSource implements ByteSource {
  constructor(
    readonly url: string,
    readonly size: number,
  ) {}
  async read(offset: number, length: number): Promise<Uint8Array> {
    checkRange(this.size, offset, length);
    if (!length) return new Uint8Array();
    const response = await fetch(this.url, {
      headers: {Range: `bytes=${offset}-${offset + length - 1}`},
    });
    if (
      response.status !== 206 ||
      response.headers.get('Content-Range') !==
        `bytes ${offset}-${offset + length - 1}/${this.size}`
    ) {
      await response.body?.cancel();
      throw new Error('Server must honor byte ranges; refusing to download an entire archive');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== length) throw new Error('Truncated HTTP range');
    return bytes;
  }
}
/** A bounded view of another source; offsets stay relative to this view. */
export class SliceSource implements ByteSource {
  constructor(
    readonly source: ByteSource,
    readonly offset: number,
    readonly size: number,
  ) {
    checkRange(source.size, offset, size);
  }
  read(offset: number, length: number): Promise<Uint8Array> {
    checkRange(this.size, offset, length);
    return this.source.read(this.offset + offset, length);
  }
}

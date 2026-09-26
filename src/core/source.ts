import {checkRange} from './binary.js';
import {beginLocalRead, beginRemoteRead} from './source-activity.js';
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
}
export class BlobSource implements ByteSource {
  readonly size: number;
  constructor(readonly blob: Blob) {
    this.size = blob.size;
  }
  async read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    checkRange(this.size, offset, length);
    signal?.throwIfAborted();
    if (!length) return new Uint8Array();
    const finished = beginLocalRead();
    let received = 0;
    try {
      const bytes = new Uint8Array(await this.blob.slice(offset, offset + length).arrayBuffer());
      signal?.throwIfAborted();
      received = bytes.length;
      return bytes;
    } finally {
      finished(received);
    }
  }
}
export class HttpSource implements ByteSource {
  constructor(
    readonly url: string,
    readonly size: number,
  ) {}
  async read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    checkRange(this.size, offset, length);
    signal?.throwIfAborted();
    if (!length) return new Uint8Array();
    const finished = beginRemoteRead();
    let received = 0;
    try {
      const response = await fetch(this.url, {
        headers: {Range: `bytes=${offset}-${offset + length - 1}`},
        signal,
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
      received = bytes.length;
      return bytes;
    } finally {
      finished(received);
    }
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
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    checkRange(this.size, offset, length);
    return this.source.read(this.offset + offset, length, signal);
  }
}

/** Expose an untransformed local file region to browser consumers without a JS byte copy.
 * Unknown/transformed sources retain their normal read path; this never starts a fetch.
 */
export function sourceBlob(
  source: ByteSource,
  offset = 0,
  length = source.size - offset,
): Blob | null {
  checkRange(source.size, offset, length);
  while (source instanceof SliceSource) {
    offset += source.offset;
    source = source.source;
  }
  return source instanceof BlobSource ? source.blob.slice(offset, offset + length) : null;
}

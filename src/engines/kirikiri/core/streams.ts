/**
 * `tTJSBinaryStream` implementations: a stream over bytes in memory, and a stream over a file
 * that holds the ranges it has fetched. Reads are synchronous; `prefetch` loads a range.
 */
import type {ByteSource} from '../../../core/source.js';
import {throwTjsError, TjsError} from '../tjs2/runtime/errors.js';
import {
  TJS_BS_SEEK_CUR,
  TJS_BS_SEEK_END,
  TJS_BS_SEEK_SET,
  type TjsBinaryStream,
} from '../tjs2/runtime/interface.js';

function seekTo(position: number, size: number, offset: number, whence: number): number {
  let p: number;
  switch (whence) {
    case TJS_BS_SEEK_SET:
      p = offset;
      break;
    case TJS_BS_SEEK_CUR:
      p = position + offset;
      break;
    case TJS_BS_SEEK_END:
      p = size + offset;
      break;
    default:
      p = position;
  }
  if (p < 0) throwTjsError('TVPSeekError');
  return p;
}

/** `tTVPMemoryStream`: a growable byte buffer. */
export class MemoryStream implements TjsBinaryStream {
  #data: Uint8Array;
  #size: number;
  #position = 0;

  constructor(data: Uint8Array = new Uint8Array(0)) {
    this.#data = data;
    this.#size = data.length;
  }

  /** The stream's bytes (a view, valid until the next write). */
  get bytes(): Uint8Array {
    return this.#data.subarray(0, this.#size);
  }

  seek(offset: number, whence: number): number {
    this.#position = seekTo(this.#position, this.#size, offset, whence);
    return this.#position;
  }
  read(length: number): Uint8Array {
    const start = Math.min(this.#position, this.#size);
    const end = Math.min(start + length, this.#size);
    this.#position = end;
    return this.#data.slice(start, end);
  }
  prefetch(): void {}
  write(data: Uint8Array): number {
    const end = this.#position + data.length;
    if (end > this.#data.length) {
      const grown = new Uint8Array(Math.max(end, this.#data.length * 2, 256));
      grown.set(this.#data.subarray(0, this.#size));
      this.#data = grown;
    }
    this.#data.set(data, this.#position);
    this.#position = end;
    if (end > this.#size) this.#size = end;
    return data.length;
  }
  setEndOfStorage(): void {
    this.#size = this.#position;
  }
  getSize(): number {
    return this.#size;
  }
  destruct(): void {}
}

/**
 * A read-only stream over a large file. Only prefetched ranges are readable; reading anything
 * else is an error, because natively the read would block on disk.
 */
export class SourceStream implements TjsBinaryStream {
  #position = 0;
  /** Loaded ranges, sorted and disjoint: [offset, bytes]. */
  readonly #ranges: {offset: number; bytes: Uint8Array}[] = [];

  constructor(
    readonly name: string,
    private readonly source: ByteSource,
  ) {}

  seek(offset: number, whence: number): number {
    this.#position = seekTo(this.#position, this.source.size, offset, whence);
    return this.#position;
  }

  read(length: number): Uint8Array {
    const start = Math.min(this.#position, this.source.size);
    const end = Math.min(start + length, this.source.size);
    this.#position = end;
    if (end === start) return new Uint8Array(0);
    const r = this.#ranges.find((x) => x.offset <= start && x.offset + x.bytes.length >= end);
    if (!r) throw new TjsError(`Storage ${this.name}: range ${start}+${end - start} is not loaded`);
    return r.bytes.slice(start - r.offset, end - r.offset);
  }

  prefetch(offset: number, length: number): void | Promise<void> {
    const start = Math.max(0, Math.min(offset, this.source.size));
    const end = Math.min(start + length, this.source.size);
    if (end <= start) return;
    if (this.#ranges.some((x) => x.offset <= start && x.offset + x.bytes.length >= end)) return;
    return this.source.read(start, end - start).then((bytes) => {
      this.#ranges.push({offset: start, bytes});
      this.#ranges.sort((a, b) => a.offset - b.offset);
    });
  }

  write(): number {
    throwTjsError('TVPWriteError');
  }
  setEndOfStorage(): void {
    throwTjsError('TVPTruncateError');
  }
  getSize(): number {
    return this.source.size;
  }
  destruct(): void {
    this.#ranges.length = 0;
  }
}

/** Reads the whole stream: prefetches it if needed, then returns its bytes. */
export function readWholeStream(stream: TjsBinaryStream): Uint8Array | Promise<Uint8Array> {
  const size = stream.getSize();
  const read = () => {
    stream.seek(0, TJS_BS_SEEK_SET);
    return stream.read(size);
  };
  const pending = stream.prefetch(0, size);
  return pending ? pending.then(read) : read();
}

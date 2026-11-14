import {checkRange} from './binary.js';
import {beginLocalRead, beginRemoteRead} from './source-activity.js';
import {beginRuntimeSpan, recordRuntimeMetric} from '../platform/runtime-performance.js';
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
}
/**
 * Small reads from device files larger than one window fetch the whole window. Android
 * content-URI file reads cost ~0.3 s each whatever their size, and archive loading issues
 * hundreds of small sequential reads; of 64 KiB-32 MiB windows, 8 MiB was fastest on a
 * replayed Amakano 3 startup on a phone (1120 reads: 315 s unwindowed, 6.4 s).
 */
const READ_AHEAD_BYTES = 8 << 20,
  READ_AHEAD_WINDOWS = 4;
interface ReadAheadWindow {
  readonly blob: Blob;
  readonly offset: number;
  readonly end: number;
  readonly bytes: Promise<Uint8Array>;
  settled: boolean;
}
/** Shared by every source of this realm, most recently used last. */
const windows: ReadAheadWindow[] = [];
export class BlobSource implements ByteSource {
  readonly size: number;
  constructor(readonly blob: Blob) {
    this.size = blob.size;
  }
  async read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    checkRange(this.size, offset, length);
    signal?.throwIfAborted();
    if (!length) return new Uint8Array();
    if (
      length >= READ_AHEAD_BYTES ||
      this.size <= READ_AHEAD_BYTES ||
      typeof File === 'undefined' ||
      !(this.blob instanceof File)
    )
      return this.readBlob(offset, length, signal);
    let window = windows.find(
      (entry) => entry.blob === this.blob && entry.offset <= offset && offset + length <= entry.end,
    );
    if (window) windows.splice(windows.indexOf(window), 1);
    else {
      const end = Math.min(this.size, offset + READ_AHEAD_BYTES),
        created: ReadAheadWindow = {
          blob: this.blob,
          offset,
          end,
          bytes: this.readBlob(offset, end - offset),
          settled: false,
        };
      // A failed window is not reused; its readers still receive the failure.
      created.bytes.then(
        () => void (created.settled = true),
        () => {
          const index = windows.indexOf(created);
          if (index >= 0) windows.splice(index, 1);
        },
      );
      // Windows still being read stay: their next readers would read them again.
      while (windows.length >= READ_AHEAD_WINDOWS) {
        const index = windows.findIndex((entry) => entry.settled);
        if (index < 0) break;
        windows.splice(index, 1);
      }
      window = created;
    }
    windows.push(window);
    const bytes = await window.bytes;
    signal?.throwIfAborted();
    return bytes.slice(offset - window.offset, offset - window.offset + length);
  }
  private async readBlob(
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const finished = beginLocalRead();
    const finishTiming = beginRuntimeSpan('source.local-read');
    let received = 0,
      success = false;
    try {
      const bytes = new Uint8Array(await this.blob.slice(offset, offset + length).arrayBuffer());
      signal?.throwIfAborted();
      received = bytes.length;
      success = true;
      return bytes;
    } finally {
      finishTiming?.({
        sourceBytes: this.size,
        offset,
        requestedBytes: length,
        completedBytes: received,
        success,
      });
      if (success) recordRuntimeMetric('source.local-read.completed-bytes', received);
      finished(received);
    }
  }
}
/** True when every read returns a new array that no other holder references. */
export function readsFreshBytes(source: ByteSource): boolean {
  while (source instanceof SliceSource) source = source.source;
  return source instanceof BlobSource;
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
    const finishTiming = beginRuntimeSpan('source.remote-read');
    let received = 0,
      success = false;
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
      success = true;
      return bytes;
    } finally {
      finishTiming?.({
        sourceBytes: this.size,
        offset,
        requestedBytes: length,
        completedBytes: received,
        success,
      });
      if (success) recordRuntimeMetric('source.remote-read.completed-bytes', received);
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

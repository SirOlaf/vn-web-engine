import {BlobSource, HttpSource, SliceSource} from './source.js';
import type {ByteSource} from './source.js';
/** Structured-clone-safe description shared by audio/video workers. */
export type WorkerSource =
  | {kind: 'blob'; blob: Blob}
  | {kind: 'http'; url: string; size: number; offset: number; length: number};
export function openWorkerSource(source: WorkerSource): ByteSource {
  return source.kind === 'blob'
    ? new BlobSource(source.blob)
    : new SliceSource(new HttpSource(source.url, source.size), source.offset, source.length);
}

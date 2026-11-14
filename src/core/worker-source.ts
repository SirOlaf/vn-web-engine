import {BlobSource, HttpSource, SliceSource, sourceBlob} from './source.js';
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
/** A worker description of `source`: its backing blob or HTTP range when it has one, else
 * its bytes copied into a blob. */
export async function workerSourceOf(source: ByteSource): Promise<WorkerSource> {
  const blob = sourceBlob(source);
  if (blob) return {kind: 'blob', blob};
  if (source instanceof HttpSource)
    return {kind: 'http', url: source.url, size: source.size, offset: 0, length: source.size};
  const bytes = await source.read(0, source.size);
  return {kind: 'blob', blob: new Blob([bytes.slice().buffer])};
}

import {BlobSource} from '../core/source.js';
import {beginLocalRead} from '../core/source-activity.js';
import {readSfntFontMetadata, type SfntFontMetadata} from '../formats/sfnt.js';
import {beginRuntimeSpan} from '../platform/runtime-performance.js';
import {getRuntimeProfile} from '../platform/runtime-profile.js';
import {beginRuntimeActivity} from '../platform/runtime-activity.js';
import {
  IndexedDbLocalFontMetadataCache,
  type LocalFontMetadataCache,
} from './local-font-metadata-cache.js';
import type {
  LocalFontMetadataRequest,
  LocalFontMetadataResponse,
} from './local-font-metadata-worker.js';

export interface BrowserLocalFontRecord {
  readonly family: string;
  readonly fullName: string;
  readonly postscriptName: string;
  blob(): Promise<Blob>;
}

export interface BrowserLocalFontHost {
  queryLocalFonts?: () => Promise<readonly BrowserLocalFontRecord[]>;
}

export interface BrowserLocalFontMetadata {
  readonly family: string;
  readonly fullName: string;
  readonly postscriptName: string;
  readonly data: SfntFontMetadata;
}

type MetadataParser = (blob: Blob) => Promise<readonly SfntFontMetadata[]>;

const parseInThread: MetadataParser = (blob) => readSfntFontMetadata(new BlobSource(blob));

/**
 * Blob range reads and sfnt parsing for one catalog, off the main thread. Installed-font
 * Blobs come from the window-only Local Font Access API and are posted one per job, so the
 * caller's job limit still bounds live font data. A worker failure falls back to parsing
 * in-thread; per-font read and parse failures remain per-font.
 */
class MetadataWorker {
  private readonly worker: Worker;
  /** Resolves with the worker's result, or undefined when the worker itself failed. */
  private readonly pending = new Map<
    number,
    (result: LocalFontMetadataResponse | undefined) => void
  >();
  private nextId = 1;
  private failed = false;
  constructor() {
    this.worker = new Worker(new URL('./local-font-metadata-worker.js', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = ({data}: MessageEvent<LocalFontMetadataResponse>) => {
      const resolve = this.pending.get(data.id);
      this.pending.delete(data.id);
      resolve?.(data);
    };
    this.worker.onerror = this.worker.onmessageerror = () => this.fail();
  }
  private fail(): void {
    this.failed = true;
    this.worker.terminate();
    const jobs = [...this.pending.values()];
    this.pending.clear();
    for (const resolve of jobs) resolve(undefined);
  }
  readonly parse: MetadataParser = async (blob) => {
    if (this.failed || !(blob instanceof Blob)) return parseInThread(blob);
    const id = this.nextId++,
      finished = beginLocalRead();
    let bytes = 0;
    try {
      const result = await new Promise<LocalFontMetadataResponse | undefined>((resolve) => {
        this.pending.set(id, resolve);
        this.worker.postMessage({id, blob} satisfies LocalFontMetadataRequest);
      });
      if (result === undefined) return parseInThread(blob);
      bytes = result.bytes;
      if (result.faces === null) throw new RangeError('Installed font metadata is unreadable');
      return result.faces;
    } finally {
      finished(bytes);
    }
  };
  close(): void {
    this.worker.terminate();
  }
}

/** Parsed faces of one record; empty when the font is denied or unreadable. */
async function readRecord(
  record: BrowserLocalFontRecord,
  parse: MetadataParser,
): Promise<readonly SfntFontMetadata[]> {
  try {
    // Metadata reads cover only the header, directory and needed tables (nearby tables
    // share one read; see readSfntFontMetadata). The complete font Blob stays local to
    // this job and is not part of the returned catalog.
    const finishBlob = beginRuntimeSpan('text.font.local-blob');
    let blob: Blob;
    try {
      blob = await record.blob();
    } finally {
      finishBlob?.();
    }
    const finishMetadata = beginRuntimeSpan('text.font.local-metadata');
    try {
      return await parse(blob);
    } finally {
      finishMetadata?.();
    }
  } catch {
    // Denied or unreadable installed faces are unavailable to this host.
    return [];
  }
}

function withRecordNames(
  record: BrowserLocalFontRecord,
  faces: readonly SfntFontMetadata[],
): BrowserLocalFontMetadata[] {
  return faces.map((data) => ({
    data,
    family: record.family,
    fullName: record.fullName,
    postscriptName: record.postscriptName,
  }));
}

/** Cache identity; the browser reports no file version without reading the Blob. */
function recordKey({family, fullName, postscriptName}: BrowserLocalFontRecord): string {
  return JSON.stringify([postscriptName, fullName, family]);
}

let defaultCache: LocalFontMetadataCache | undefined;

/** Query installed font records; a missing API or a denied query yields no records. */
export async function queryBrowserLocalFonts(
  host: BrowserLocalFontHost = globalThis as BrowserLocalFontHost,
): Promise<readonly BrowserLocalFontRecord[]> {
  if (!host.queryLocalFonts) return [];
  const finishQuery = beginRuntimeSpan('text.font.local-query');
  try {
    return await host.queryLocalFonts();
  } catch {
    return [];
  } finally {
    finishQuery?.();
  }
}

/**
 * Read metadata for the given records, one result per record in record order. Unreadable
 * records yield no faces; collections keep their face order. Cached records skip their
 * Blob and table reads; newly readable records are added to the cache.
 */
export async function readBrowserLocalFontRecords(
  records: readonly BrowserLocalFontRecord[],
  concurrency: number = getRuntimeProfile() === 'browser-optimized' ? 4 : 1,
  cache: LocalFontMetadataCache = (defaultCache ??= new IndexedDbLocalFontMetadataCache()),
): Promise<BrowserLocalFontMetadata[][]> {
  const finishCatalog = beginRuntimeSpan('text.font.local-catalog');
  const results: BrowserLocalFontMetadata[][] = new Array(records.length);
  const keys = records.map(recordKey);
  const cached = await cache.getMany([...new Set(keys)]);
  const unread: number[] = [];
  records.forEach((record, index) => {
    const faces = cached.get(keys[index]!);
    if (faces) results[index] = withRecordNames(record, faces);
    else unread.push(index);
  });
  let metadataWorker: MetadataWorker | null = null;
  const finishActivity =
    unread.length === 0
      ? undefined
      : beginRuntimeActivity('Processing installed fonts', {total: unread.length, essential: true});
  const fresh = new Map<string, readonly SfntFontMetadata[]>();
  try {
    if (unread.length !== 0 && typeof Worker !== 'undefined') {
      try {
        metadataWorker = new MetadataWorker();
      } catch {
        // Construction failures keep in-thread parsing.
      }
    }
    const parse = metadataWorker?.parse ?? parseInThread;
    const read = async (index: number): Promise<void> => {
      const record = records[index]!;
      const faces = await readRecord(record, parse);
      // Failures may be transient permission or I/O errors; only parsed fonts are kept.
      if (faces.length !== 0) fresh.set(keys[index]!, faces);
      results[index] = withRecordNames(record, faces);
      finishActivity?.advance();
    };
    if (concurrency === 1) for (const index of unread) await read(index);
    else {
      // Reads may finish out of order; results stay indexed by record. Limit live
      // Blob/table-read jobs to bound memory and I/O.
      let next = 0;
      const job = async (): Promise<void> => {
        while (next < unread.length) await read(unread[next++]!);
      };
      await Promise.all(Array.from({length: Math.min(concurrency, unread.length)}, job));
    }
    await cache.putMany(fresh);
    return results;
  } finally {
    metadataWorker?.close();
    finishActivity?.();
    finishCatalog?.({
      concurrency,
      records: records.length,
      cached: records.length - unread.length,
      worker: metadataWorker !== null,
    });
  }
}

/** Enumerate installed font metadata without retaining glyph data or rebuilding collection faces. */
export async function readBrowserLocalFontMetadata(
  host: BrowserLocalFontHost = globalThis as BrowserLocalFontHost,
  cache?: LocalFontMetadataCache,
): Promise<readonly BrowserLocalFontMetadata[]> {
  // Snapshot the job limit before the query; a policy change while it is pending
  // applies to the next catalog.
  const concurrency = getRuntimeProfile() === 'browser-optimized' ? 4 : 1;
  const records = await queryBrowserLocalFonts(host);
  return (await readBrowserLocalFontRecords(records, concurrency, cache)).flat();
}
